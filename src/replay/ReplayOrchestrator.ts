import type { Workflow, WorkflowStep } from '../shared/types/workflow';
import { WaitManager } from './WaitManager';
import { WaitError } from './timeout-config';
import { WorkflowStorage } from '../workflow/storage/WorkflowStorage';
import { CURRENT_SESSION_SCHEMA_VERSION } from '../workflow/storage/storage-keys';
import { ReplaySessionStorage } from './session/ReplaySessionStorage';
import type {
  ReplaySession,
  DatasetExecutionState,
  RecoveryEvidence,
  RecoveryDecision,
} from './session/session-types';
import { VariableContext } from './VariableContext';
import { DatasetParser, type ParsedDataset } from './dataset/DatasetParser';
import { ConditionEvaluator } from './ConditionEvaluator';
import type { VerificationResult } from './verification-types';
import { isSafeUrl } from '../workflow/storage/schema';
import { classifyActionSafety } from './ActionVerifier';
import { ExecutionHistoryManager } from '../automation/history/ExecutionHistoryManager';
import type { FailureCategory } from '../automation/history/history-types';

export class ReplayOrchestrator {
  private activeSession: ReplaySession | null = null;
  private activeSessionId: string | null = null;
  private workflow: Workflow | null = null;
  private abortController: AbortController | null = null;
  private isReconciling = false;
  private variables: Record<string, any> = {};
  private variableContext: VariableContext | null = null;
  private baseVariableContext: VariableContext | null = null;
  private activeDataset: ParsedDataset | null = null;
  private stepVerifications: Map<string, VerificationResult> = new Map();

  public getSession(): ReplaySession | null {
    return this.activeSession ? { ...this.activeSession } : null;
  }

  private isExecutionAborted(): boolean {
    if (!this.activeSession || !this.activeSessionId) return true;
    if (this.activeSessionId !== this.activeSession.sessionId) return true;
    if (this.activeSession.cancellationRequested) return true;
    if (this.abortController?.signal.aborted) return true;
    const status = this.activeSession.status as string;
    return status === 'PAUSED' || status === 'CANCELLED';
  }

  private recordExecutionHistory(
    status: 'SUCCESS' | 'FAILED' | 'RECOVERY_REQUIRED' | 'CANCELLED',
    failureCategory: FailureCategory = 'NONE',
    failureReason?: string
  ): void {
    if (!this.activeSession) return;
    const now = Date.now();
    const durationMs = Math.max(0, now - (this.activeSession.startedAt || now));
    const currentStep = this.workflow?.steps?.[this.activeSession.currentStepIndex];

    ExecutionHistoryManager.recordEntry({
      id: `HIST_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sessionId: this.activeSession.sessionId,
      workflowId: this.activeSession.workflowId,
      workflowName: this.activeSession.workflowName,
      status,
      startTime: this.activeSession.startedAt || now,
      endTime: now,
      durationMs,
      totalSteps: this.activeSession.totalSteps,
      executedSteps: this.activeSession.stepExecutionCount || this.activeSession.currentStepIndex,
      verifiedSteps: this.stepVerifications.size,
      failedStepId: currentStep?.id,
      failureCategory,
      failureReason: failureReason || this.activeSession.lastError || undefined,
      recoveryAttempts: this.activeSession.attemptCount || 0,
      datasetRecordIndex: this.activeSession.datasetState?.currentRecordIndex,
      datasetTotalRecords: this.activeSession.datasetState?.totalRecords,
    }).catch((err) => {
      console.warn('[ReplayOrchestrator] Failed to record execution history:', err);
    });
  }

  /**
   * Starts a new replay session for the given workflow.
   * Rejects if another active replay session is already in progress.
   */
  public async start(
    workflow: Workflow,
    variables: Record<string, any> = {},
    speedMultiplier: number = 1,
    tabId?: number,
    dataset?: ParsedDataset | null
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    // Check if an existing session is currently active
    const existing = await ReplaySessionStorage.getActiveSession();
    if (
      existing &&
      (existing.status === 'RUNNING' ||
        existing.status === 'WAITING' ||
        existing.status === 'NAVIGATING' ||
        existing.status === 'PAUSED' ||
        existing.status === 'STARTING')
    ) {
      const msg = `Cannot start workflow. Session ${existing.sessionId} is already active (${existing.status}).`;
      console.warn('[ReplayOrchestrator]', msg);
      return { success: false, error: msg, sessionId: existing.sessionId };
    }

    // Cancel any previous in-memory abort controller
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    let targetTabId: number | null = tabId || null;
    if (!targetTabId) {
      const tab = await this.getTargetTab();
      targetTabId = tab?.id || null;
    }

    const sessionId = `SES_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Initialize variable context with validation
    try {
      this.baseVariableContext = new VariableContext(
        workflow.variables || [],
        variables,
        dataset ? dataset.records[0] : {},
        {
          _stepIndex: 1,
          _recordIndex: 0,
          _timestamp: Date.now(),
          _workflowId: workflow.id,
          _sessionId: sessionId,
        }
      );
      this.variableContext = dataset
        ? this.baseVariableContext.createRecordContext(dataset.records[0], 0)
        : this.baseVariableContext;

      if (!dataset) {
        this.variableContext.validateRequiredVariables();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Variable initialization error';
      console.error('[ReplayOrchestrator] Variable validation failed:', msg);
      return { success: false, error: msg };
    }

    let datasetState: DatasetExecutionState | undefined = undefined;
    if (dataset && dataset.records.length > 0) {
      this.activeDataset = dataset;
      datasetState = {
        fingerprint: dataset.fingerprint,
        totalRecords: dataset.records.length,
        currentRecordIndex: 0,
        status: 'RUNNING',
        completedRecords: [],
        failedRecords: [],
        skippedRecords: [],
        records: dataset.records,
        hasUnsafeActionExecutedInCurrentRecord: false,
      };
    }

    const newSession: ReplaySession = {
      sessionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowSchemaVersion: workflow.schemaVersion || 2,
      sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      totalSteps: workflow.steps.length,
      targetTabId,
      currentStepIndex: 0,
      lastCompletedStepIndex: -1,
      status: 'STARTING',
      actionState: 'NOT_STARTED',
      currentActionId: null,
      attemptCount: 0,
      speedMultiplier: Math.max(0.25, Math.min(speedMultiplier, 5)),
      variables: this.variableContext.getAllVariables(),
      extractedVariables: {},
      datasetState,
      stepExecutionCount: 0,
      totalStepExecutionCount: 0,
      maxStepBudget: workflow.settings?.maxStepBudget || 500,
      navigationPending: false,
      cancellationRequested: false,
      lastError: null,
      sessionRevision: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      eventLog: [],
    };

    ReplaySessionStorage.appendEvent(newSession, 'SESSION_CREATED', `Workflow "${workflow.name}" started`);
    if (datasetState) {
      ReplaySessionStorage.appendEvent(
        newSession,
        'DATASET_STARTED',
        `Dataset replay started with ${datasetState.totalRecords} records (Fingerprint: ${datasetState.fingerprint})`
      );
      ReplaySessionStorage.appendEvent(
        newSession,
        'DATASET_RECORD_STARTED',
        `Starting record 1 of ${datasetState.totalRecords}`
      );
    }

    this.activeSession = await ReplaySessionStorage.saveSession(newSession);
    this.activeSessionId = sessionId;
    this.workflow = workflow;
    this.variables = variables;
    this.stepVerifications.clear();

    console.log(
      `[ReplayOrchestrator] Session ${sessionId} started for workflow: ${workflow.id}, Tab: ${targetTabId}`
    );

    this.broadcastStatusChange();
    void this.executeNextStep();

    return { success: true, sessionId };
  }

  /**
   * Starts a dataset-driven replay against a CSV or JSON dataset.
   */
  public async startWithDataset(
    workflow: Workflow,
    datasetInput: ParsedDataset | string,
    options: {
      variables?: Record<string, any>;
      speedMultiplier?: number;
      tabId?: number;
    } = {}
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    let dataset: ParsedDataset;
    try {
      if (typeof datasetInput === 'string') {
        const trimmed = datasetInput.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          dataset = DatasetParser.parseJSON(trimmed, {
            requiredColumns: workflow.datasetConfig?.requiredColumns,
            maxRows: workflow.datasetConfig?.maxRows,
          });
        } else {
          dataset = DatasetParser.parseCSV(trimmed, {
            requiredColumns: workflow.datasetConfig?.requiredColumns,
            maxRows: workflow.datasetConfig?.maxRows,
          });
        }
      } else {
        dataset = datasetInput;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to parse dataset';
      return { success: false, error: msg };
    }

    return this.start(workflow, options.variables || {}, options.speedMultiplier || 1, options.tabId, dataset);
  }

  /**
   * Reconciles persisted session state when the background service worker boots.
   */
  public async reconcileSessionOnBoot(): Promise<void> {
    if (this.isReconciling) return;
    this.isReconciling = true;

    try {
      const persisted = await ReplaySessionStorage.getActiveSession();
      if (!persisted) {
        return;
      }

      console.log(
        `[ReplayOrchestrator] Reconciling session ${persisted.sessionId} on service worker boot. Status: ${persisted.status}, ActionState: ${persisted.actionState}`
      );

      // Terminal sessions are cleaned up
      if (
        persisted.status === 'COMPLETED' ||
        persisted.status === 'CANCELLED' ||
        persisted.status === 'FAILED'
      ) {
        await ReplaySessionStorage.clearActiveSession();
        return;
      }

      // Check if target tab still exists
      if (persisted.targetTabId) {
        try {
          const tab = await chrome.tabs.get(persisted.targetTabId);
          if (!tab) throw new Error('Tab not found');
        } catch {
          console.warn(
            `[ReplayOrchestrator] Target tab ${persisted.targetTabId} no longer exists. Marking session as FAILED.`
          );
          persisted.status = 'FAILED';
          persisted.lastError = 'Target tab was closed during replay';
          persisted.lastErrorCode = 'TAB_CLOSED';
          ReplaySessionStorage.appendEvent(
            persisted,
            'SESSION_FAILED',
            'Target tab was closed during service worker restart'
          );
          await ReplaySessionStorage.saveSession(persisted);
          this.activeSession = persisted;
          this.broadcastStatusChange();
          return;
        }
      }

      // If paused, keep paused
      if (persisted.status === 'PAUSED') {
        const wf = await WorkflowStorage.getWorkflowById(persisted.workflowId);
        if (wf) this.workflow = wf;
        this.activeSession = persisted;
        this.activeSessionId = persisted.sessionId;
        if (persisted.datasetState?.records && persisted.datasetState.records.length > 0) {
          this.activeDataset = {
            records: persisted.datasetState.records,
            columns: Object.keys(persisted.datasetState.records[0] || {}),
            rowCount: persisted.datasetState.records.length,
            fingerprint: persisted.datasetState.fingerprint,
          };
        }
        ReplaySessionStorage.appendEvent(
          persisted,
          'SESSION_RESTORED',
          'Restored in PAUSED state after service worker restart'
        );
        await ReplaySessionStorage.saveSession(persisted);
        this.broadcastStatusChange();
        return;
      }

      // If already in RECOVERY_REQUIRED or OUTCOME_UNKNOWN, preserve state
      if (
        persisted.status === 'RECOVERY_REQUIRED' ||
        persisted.actionState === 'OUTCOME_UNKNOWN'
      ) {
        const wf = await WorkflowStorage.getWorkflowById(persisted.workflowId);
        if (wf) this.workflow = wf;
        this.activeSession = persisted;
        this.activeSessionId = persisted.sessionId;
        if (persisted.datasetState?.records && persisted.datasetState.records.length > 0) {
          this.activeDataset = {
            records: persisted.datasetState.records,
            columns: Object.keys(persisted.datasetState.records[0] || {}),
            rowCount: persisted.datasetState.records.length,
            fingerprint: persisted.datasetState.fingerprint,
          };
        }
        ReplaySessionStorage.appendEvent(
          persisted,
          'SESSION_RESTORED',
          'Restored in RECOVERY_REQUIRED state after service worker restart'
        );
        await ReplaySessionStorage.saveSession(persisted);
        this.broadcastStatusChange();
        return;
      }

      // Checkpoint 4: Service worker terminated after verification but before advancing step
      if (persisted.actionState === 'VERIFIED') {
        console.log(
          `[ReplayOrchestrator] Action was verified before restart. Advancing step ${persisted.currentStepIndex + 1}.`
        );
        persisted.lastCompletedStepIndex = persisted.currentStepIndex;
        persisted.currentStepIndex++;
        persisted.actionState = 'NOT_STARTED';
        persisted.currentActionId = null;
        persisted.attemptCount = 0;
        persisted.status = 'WAITING';
        ReplaySessionStorage.appendEvent(
          persisted,
          'STEP_CHECKPOINT_SAVED',
          'Advanced verified step after service worker restart'
        );
        await ReplaySessionStorage.saveSession(persisted);
      }

      // Check uncertain action dispatch or verification in progress
      if (persisted.actionState === 'DISPATCHING' || persisted.actionState === 'VERIFYING') {
        // Query content script to check if the action actually executed
        let executed = false;
        if (persisted.targetTabId && persisted.currentActionId) {
          try {
            const resp = await chrome.tabs.sendMessage(persisted.targetTabId, {
              type: 'CHECK_ACTION_EXECUTED',
              payload: { actionId: persisted.currentActionId },
            });
            executed = Boolean(resp?.executed);
          } catch {
            executed = false;
          }
        }

        if (executed) {
          // Action executed! Advance step index safely
          console.log(
            `[ReplayOrchestrator] Content script confirmed action ${persisted.currentActionId} executed. Advancing checkpoint.`
          );
          persisted.actionState = 'VERIFIED';
          persisted.lastCompletedStepIndex = persisted.currentStepIndex;
          persisted.currentStepIndex++;
          persisted.currentActionId = null;
          persisted.attemptCount = 0;
          persisted.status = 'WAITING';
          ReplaySessionStorage.appendEvent(
            persisted,
            'STEP_CHECKPOINT_SAVED',
            'Reconciled dispatched action after service worker restart'
          );
          await ReplaySessionStorage.saveSession(persisted);
        } else {
          // Outcome is uncertain! To prevent non-idempotent duplicate clicks/submits, require attention
          console.warn(
            `[ReplayOrchestrator] Outcome of action ${persisted.currentActionId} is uncertain after service worker restart. Marking RECOVERY_REQUIRED.`
          );
          persisted.status = 'RECOVERY_REQUIRED';
          persisted.actionState = 'OUTCOME_UNKNOWN';
          persisted.lastError =
            'Service worker restarted while action was dispatching. Action outcome is uncertain.';

          const wf = await WorkflowStorage.getWorkflowById(persisted.workflowId);
          const currentStep = wf?.steps[persisted.currentStepIndex];
          const safety = currentStep ? classifyActionSafety(currentStep) : 'EXTERNAL_SIDE_EFFECT';
          if (!persisted.recoveryContext) {
            persisted.recoveryContext = {
              interruptedStepIndex: persisted.currentStepIndex,
              interruptedActionId: persisted.currentActionId || '',
              safetyCategory: safety,
              reason: persisted.lastError,
              evidence: [
                {
                  id: `EVD_${Date.now()}_boot`,
                  type: 'inconclusive',
                  timestamp: Date.now(),
                  stepIndex: persisted.currentStepIndex,
                  actionId: persisted.currentActionId || '',
                  result: 'UNCERTAIN',
                  description: 'Service worker restarted while action was in flight. Outcome uncertain.',
                  source: 'AUTOMATED_CHECK',
                  isUserProvided: false,
                },
              ],
              history: [],
            };
          }

          ReplaySessionStorage.appendEvent(
            persisted,
            'SESSION_RECOVERY_REQUIRED',
            persisted.lastError
          );
          await ReplaySessionStorage.saveSession(persisted);
          this.activeSession = persisted;
          this.broadcastStatusChange();
          return;
        }
      }

      // Load workflow and restore execution loop
      const wf = await WorkflowStorage.getWorkflowById(persisted.workflowId);
      if (!wf) {
        persisted.status = 'FAILED';
        persisted.lastError = `Workflow ${persisted.workflowId} no longer found in storage`;
        ReplaySessionStorage.appendEvent(persisted, 'SESSION_FAILED', persisted.lastError);
        await ReplaySessionStorage.saveSession(persisted);
        this.activeSession = persisted;
        this.broadcastStatusChange();
        return;
      }

      this.workflow = wf;
      this.abortController = new AbortController();
      this.activeSession = persisted;
      this.activeSessionId = persisted.sessionId;

      if (persisted.variables) {
        this.variables = persisted.variables;
        this.baseVariableContext = VariableContext.fromSerializable({
          declarations: wf.variables || [],
          userVars: persisted.variables,
          extractedVars: persisted.extractedVariables || {},
          systemVars: {
            _stepIndex: persisted.currentStepIndex + 1,
            _recordIndex: persisted.datasetState?.currentRecordIndex ?? 0,
            _workflowId: persisted.workflowId,
            _sessionId: persisted.sessionId,
          },
        });
        this.variableContext = this.baseVariableContext;
      }

      // Restore active dataset if persisted in session
      if (persisted.datasetState && persisted.datasetState.records) {
        this.activeDataset = {
          records: persisted.datasetState.records,
          columns: Object.keys(persisted.datasetState.records[0] || {}),
          rowCount: persisted.datasetState.records.length,
          fingerprint: persisted.datasetState.fingerprint,
        };

        const recIdx = persisted.datasetState.currentRecordIndex;
        const rec = this.activeDataset.records[recIdx];
        if (rec && this.baseVariableContext) {
          this.variableContext = this.baseVariableContext.createRecordContext(rec, recIdx);
        }
      }

      ReplaySessionStorage.appendEvent(
        persisted,
        'SESSION_RESTORED',
        `Resuming from step ${persisted.currentStepIndex + 1}/${persisted.totalSteps}`
      );
      await ReplaySessionStorage.saveSession(persisted);

      this.broadcastStatusChange();
      void this.executeNextStep();
    } catch (err: unknown) {
      console.error('[ReplayOrchestrator] Error during session reconciliation:', err);
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Pauses the active replay session idempotently.
   */
  public async pause(sessionId?: string): Promise<boolean> {
    if (!this.activeSession) {
      this.activeSession = await ReplaySessionStorage.getActiveSession();
    }
    if (!this.activeSession) return false;
    if (sessionId && this.activeSession.sessionId !== sessionId) return false;

    this.activeSession.status = 'PAUSED';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    ReplaySessionStorage.appendEvent(this.activeSession, 'SESSION_PAUSED', 'User paused session');
    this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);

    this.broadcastStatusChange();
    return true;
  }

  /**
   * Resumes a paused or recovery-required session.
   */
  public async resume(
    sessionId?: string,
    options?: { forceAdvance?: boolean; retryVerificationOnly?: boolean }
  ): Promise<boolean> {
    if (!this.activeSession) {
      this.activeSession = await ReplaySessionStorage.getActiveSession();
    }
    if (!this.activeSession) return false;
    if (sessionId && this.activeSession.sessionId !== sessionId) return false;

    if (
      this.activeSession.status !== 'PAUSED' &&
      this.activeSession.status !== 'RECOVERY_REQUIRED'
    ) {
      return false;
    }

    if (!this.workflow) {
      this.workflow = await WorkflowStorage.getWorkflowById(this.activeSession.workflowId);
      if (!this.workflow) return false;
    }

    this.activeSessionId = this.activeSession.sessionId;
    this.abortController = new AbortController();
    this.activeSession.status = 'RUNNING';

    if (options?.forceAdvance) {
      this.activeSession.lastCompletedStepIndex = this.activeSession.currentStepIndex;
      this.activeSession.currentStepIndex++;
      this.activeSession.currentActionId = null;
      this.activeSession.actionState = 'NOT_STARTED';
      this.activeSession.attemptCount = 0;
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'STEP_CHECKPOINT_SAVED',
        `User resolved recovery by advancing to step ${this.activeSession.currentStepIndex + 1}`
      );
    } else if (this.activeSession.actionState === 'OUTCOME_UNKNOWN') {
      this.activeSession.actionState = 'NOT_STARTED';
    }

    ReplaySessionStorage.appendEvent(this.activeSession, 'SESSION_RESUMED', 'User resumed session');
    this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);

    this.broadcastStatusChange();
    void this.executeNextStep();
    return true;
  }

  /**
   * Stops and cancels the active replay session. Idempotent.
   */
  public async stop(
    sessionId?: string,
    options?: { sessionRevision?: number; rationale?: string }
  ): Promise<boolean> {
    const session = this.activeSession || (await ReplaySessionStorage.getActiveSession());
    if (!session) return true;
    if (sessionId && session.sessionId !== sessionId) return false;
    if (options?.sessionRevision !== undefined && session.sessionRevision !== options.sessionRevision) {
      return false;
    }

    this.activeSessionId = null;
    session.cancellationRequested = true;
    session.status = 'CANCELLED';

    if (this.abortController) {
      this.abortController.abort();
    }

    if (session.recoveryContext) {
      session.recoveryContext.history.push({
        id: `DEC_${Date.now()}_stop`,
        decisionType: 'STOP_REPLAY',
        sessionId: session.sessionId,
        workflowId: session.workflowId,
        sessionRevision: session.sessionRevision,
        stepIndex: session.currentStepIndex,
        actionId: session.currentActionId || '',
        timestamp: Date.now(),
        authorizedByUser: true,
        recordIndex: session.datasetState?.currentRecordIndex,
        rationale: options?.rationale || 'Session stopped by user during recovery inspection',
      });
    }

    this.activeSession = null;
    this.workflow = null;

    ReplaySessionStorage.appendEvent(
      session,
      'SESSION_CANCELLED',
      'Session cancelled by user'
    );

    if (session.targetTabId) {
      chrome.tabs
        .sendMessage(session.targetTabId, { type: 'HIDE_REPLAY_INDICATOR' })
        .catch(() => {});
    }

    await ReplaySessionStorage.clearActiveSession('CANCELLED');
    this.broadcastStatusChange();
    return true;
  }

  /**
   * Rechecks the postcondition of the interrupted action without redispatching.
   */
  public async recheckRecoveryCondition(
    sessionId?: string,
    options?: { sessionRevision?: number }
  ): Promise<{ success: boolean; verification?: VerificationResult; error?: string; code?: string }> {
    const session = this.activeSession || (await ReplaySessionStorage.getActiveSession());
    if (!session) {
      return { success: false, error: 'No active session found', code: 'NO_SESSION' };
    }
    if (sessionId && session.sessionId !== sessionId) {
      return { success: false, error: 'Session ID mismatch', code: 'STALE_SESSION' };
    }
    if (options?.sessionRevision !== undefined && session.sessionRevision !== options.sessionRevision) {
      return { success: false, error: 'Session revision mismatch (concurrent update)', code: 'STALE_REVISION' };
    }
    if (session.status !== 'RECOVERY_REQUIRED') {
      return { success: false, error: `Session not in RECOVERY_REQUIRED state (status: ${session.status})`, code: 'INVALID_STATUS' };
    }

    if (!this.workflow) {
      this.workflow = await WorkflowStorage.getWorkflowById(session.workflowId);
      if (!this.workflow) {
        return { success: false, error: 'Workflow not found', code: 'WORKFLOW_NOT_FOUND' };
      }
    }

    const currentStep = this.workflow.steps[session.currentStepIndex];
    if (!currentStep) {
      return { success: false, error: 'Interrupted step not found in workflow', code: 'STEP_NOT_FOUND' };
    }

    if (!session.recoveryContext) {
      session.recoveryContext = {
        interruptedStepIndex: session.currentStepIndex,
        interruptedActionId: session.currentActionId || '',
        safetyCategory: classifyActionSafety(currentStep),
        reason: session.lastError || 'Outcome uncertain',
        evidence: [],
        history: [],
      };
    }

    ReplaySessionStorage.appendEvent(
      session,
      'RECOVERY_RECHECK_STARTED',
      `Rechecking postcondition for step ${session.currentStepIndex + 1} without redispatching`
    );

    let verificationResult: VerificationResult | undefined;

    if (session.targetTabId) {
      try {
        const resp = await chrome.tabs.sendMessage(session.targetTabId, {
          type: 'RECHECK_STEP_CONDITION',
          payload: {
            step: currentStep,
            sessionId: session.sessionId,
            actionId: session.currentActionId,
            stepIndex: session.currentStepIndex,
          },
        });
        if (resp && resp.verification) {
          verificationResult = resp.verification;
        }
      } catch (err: unknown) {
        console.warn('[ReplayOrchestrator] Content script unreachable during recheck:', err);
      }
    }

    const resultStatus = verificationResult?.status === 'VERIFIED'
      ? 'SUCCESS'
      : verificationResult?.status === 'OUTCOME_UNKNOWN'
      ? 'UNCERTAIN'
      : verificationResult ? 'FAILURE' : 'INCONCLUSIVE';

    const evidence: RecoveryEvidence = {
      id: `EVD_${Date.now()}_recheck`,
      type: 'dom_postcondition',
      timestamp: Date.now(),
      stepIndex: session.currentStepIndex,
      actionId: session.currentActionId || '',
      result: resultStatus,
      description: verificationResult?.diagnosticInfo || (verificationResult ? `Recheck returned status ${verificationResult.status}` : 'Could not reach target tab to verify postcondition'),
      source: 'AUTOMATED_CHECK',
      isUserProvided: false,
      details: verificationResult ? { method: verificationResult.method, expectedCondition: verificationResult.expectedCondition, actualState: verificationResult.actualState } : undefined,
    };

    if (session.recoveryContext) {
      session.recoveryContext.evidence.push(evidence);
    }
    if (verificationResult) {
      session.lastVerificationResult = verificationResult;
    }

    ReplaySessionStorage.appendEvent(
      session,
      'RECOVERY_RECHECK_COMPLETED',
      `Recheck completed with result: ${resultStatus}`
    );

    this.activeSession = await ReplaySessionStorage.saveSession(session);
    this.broadcastStatusChange();

    return {
      success: true,
      verification: verificationResult,
    };
  }

  /**
   * Safe, read-only inspection of the target tab's current DOM & URL state.
   */
  public async inspectRecoveryPageState(
    sessionId?: string,
    options?: { sessionRevision?: number }
  ): Promise<{ success: boolean; inspection?: any; error?: string; code?: string }> {
    const session = this.activeSession || (await ReplaySessionStorage.getActiveSession());
    if (!session) {
      return { success: false, error: 'No active session found', code: 'NO_SESSION' };
    }
    if (sessionId && session.sessionId !== sessionId) {
      return { success: false, error: 'Session ID mismatch', code: 'STALE_SESSION' };
    }
    if (options?.sessionRevision !== undefined && session.sessionRevision !== options.sessionRevision) {
      return { success: false, error: 'Session revision mismatch', code: 'STALE_REVISION' };
    }
    if (session.status !== 'RECOVERY_REQUIRED') {
      return { success: false, error: `Session not in RECOVERY_REQUIRED state (status: ${session.status})`, code: 'INVALID_STATUS' };
    }

    if (!this.workflow) {
      this.workflow = await WorkflowStorage.getWorkflowById(session.workflowId);
    }
    const currentStep = this.workflow?.steps[session.currentStepIndex];

    if (!session.recoveryContext) {
      session.recoveryContext = {
        interruptedStepIndex: session.currentStepIndex,
        interruptedActionId: session.currentActionId || '',
        safetyCategory: currentStep ? classifyActionSafety(currentStep) : 'EXTERNAL_SIDE_EFFECT',
        reason: session.lastError || 'Outcome uncertain',
        evidence: [],
        history: [],
      };
    }

    ReplaySessionStorage.appendEvent(
      session,
      'RECOVERY_INSPECTION_STARTED',
      'Inspecting current page URL and target element state'
    );

    let inspectionResp: any = null;
    if (session.targetTabId) {
      try {
        inspectionResp = await chrome.tabs.sendMessage(session.targetTabId, {
          type: 'INSPECT_PAGE_STATE',
          payload: {
            step: currentStep,
          },
        });
      } catch (err: unknown) {
        console.warn('[ReplayOrchestrator] Content script unreachable during page inspection:', err);
      }
    }

    if (inspectionResp && inspectionResp.success) {
      if (session.recoveryContext) {
        session.recoveryContext.lastInspection = {
          timestamp: Date.now(),
          url: inspectionResp.url,
          title: inspectionResp.title,
          targetFound: inspectionResp.targetFound,
          details: inspectionResp.targetDetails ? JSON.stringify(inspectionResp.targetDetails) : undefined,
        };

        if (inspectionResp.url) {
          session.recoveryContext.evidence.push({
            id: `EVD_${Date.now()}_url`,
            type: 'url_observation',
            timestamp: Date.now(),
            stepIndex: session.currentStepIndex,
            actionId: session.currentActionId || '',
            result: 'UNCERTAIN',
            description: `Observed current URL: ${inspectionResp.url}`,
            source: 'AUTOMATED_CHECK',
            isUserProvided: false,
            details: { url: inspectionResp.url, title: inspectionResp.title },
          });
        }

        if (inspectionResp.targetFound !== undefined) {
          session.recoveryContext.evidence.push({
            id: `EVD_${Date.now()}_target`,
            type: 'target_element_state',
            timestamp: Date.now(),
            stepIndex: session.currentStepIndex,
            actionId: session.currentActionId || '',
            result: inspectionResp.targetFound ? 'SUCCESS' : 'INCONCLUSIVE',
            description: inspectionResp.targetFound
              ? 'Target element found in page DOM'
              : 'Target element was not found in page DOM',
            source: 'AUTOMATED_CHECK',
            isUserProvided: false,
            details: inspectionResp.targetDetails,
          });
        }
      }
    } else {
      if (session.recoveryContext) {
        session.recoveryContext.evidence.push({
          id: `EVD_${Date.now()}_inconclusive_inspect`,
          type: 'inconclusive',
          timestamp: Date.now(),
          stepIndex: session.currentStepIndex,
          actionId: session.currentActionId || '',
          result: 'INCONCLUSIVE',
          description: 'Unable to inspect page state: target tab or content script is not responding',
          source: 'AUTOMATED_CHECK',
          isUserProvided: false,
        });
      }
    }

    this.activeSession = await ReplaySessionStorage.saveSession(session);
    this.broadcastStatusChange();

    return {
      success: true,
      inspection: inspectionResp,
    };
  }

  /**
   * User confirms the action succeeded on the destination page.
   * Advances exactly once to next step WITHOUT redispatching the action.
   */
  public async confirmRecoverySuccess(
    sessionId?: string,
    options?: { rationale?: string; sessionRevision?: number }
  ): Promise<{ success: boolean; error?: string; code?: string }> {
    const session = this.activeSession || (await ReplaySessionStorage.getActiveSession());
    if (!session) {
      return { success: false, error: 'No active session found', code: 'NO_SESSION' };
    }
    if (sessionId && session.sessionId !== sessionId) {
      return { success: false, error: 'Session ID mismatch', code: 'STALE_SESSION' };
    }
    if (options?.sessionRevision !== undefined && session.sessionRevision !== options.sessionRevision) {
      return { success: false, error: 'Session revision mismatch (concurrent update)', code: 'STALE_REVISION' };
    }
    if (session.status !== 'RECOVERY_REQUIRED') {
      return { success: false, error: `Session not in RECOVERY_REQUIRED state (status: ${session.status})`, code: 'INVALID_STATUS' };
    }

    if (!this.workflow) {
      this.workflow = await WorkflowStorage.getWorkflowById(session.workflowId);
      if (!this.workflow) {
        return { success: false, error: 'Workflow not found', code: 'WORKFLOW_NOT_FOUND' };
      }
    }

    const currentStep = this.workflow.steps[session.currentStepIndex];

    if (!session.recoveryContext) {
      session.recoveryContext = {
        interruptedStepIndex: session.currentStepIndex,
        interruptedActionId: session.currentActionId || '',
        safetyCategory: currentStep ? classifyActionSafety(currentStep) : 'EXTERNAL_SIDE_EFFECT',
        reason: session.lastError || 'Outcome uncertain',
        evidence: [],
        history: [],
      };
    }

    const decision: RecoveryDecision = {
      id: `DEC_${Date.now()}_success`,
      decisionType: 'CONFIRM_SUCCESS',
      sessionId: session.sessionId,
      workflowId: session.workflowId,
      sessionRevision: session.sessionRevision,
      stepIndex: session.currentStepIndex,
      actionId: session.currentActionId || '',
      timestamp: Date.now(),
      authorizedByUser: true,
      recordIndex: session.datasetState?.currentRecordIndex,
      rationale: options?.rationale || 'User confirmed that the action succeeded on destination page',
    };

    if (session.recoveryContext) {
      session.recoveryContext.history.push(decision);
      session.recoveryContext.evidence.push({
        id: `EVD_${Date.now()}_user_success`,
        type: 'user_confirmation',
        timestamp: Date.now(),
        stepIndex: session.currentStepIndex,
        actionId: session.currentActionId || '',
        result: 'SUCCESS',
        description: options?.rationale || 'User confirmed success after inspection. Flow continues without redispatching.',
        source: 'USER_CONFIRMATION',
        isUserProvided: true,
      });
    }

    // Advance step without redispatching
    session.lastCompletedStepIndex = session.currentStepIndex;
    session.currentStepIndex++;
    session.currentActionId = null;
    session.actionState = 'NOT_STARTED';
    session.attemptCount = 0;
    session.status = 'WAITING';
    session.lastError = null;
    session.lastErrorCode = null;

    ReplaySessionStorage.appendEvent(
      session,
      'RECOVERY_DECISION_PROCESSED',
      `User confirmed success for step ${session.lastCompletedStepIndex + 1}. Continuing next step.`
    );

    this.activeSessionId = session.sessionId;
    this.abortController = new AbortController();
    this.activeSession = await ReplaySessionStorage.saveSession(session);
    this.broadcastStatusChange();

    void this.executeNextStep();
    return { success: true };
  }

  /**
   * User confirms the action failed and authorizes retry.
   * If action is non-idempotent or has external side effects, requires explicit forceUnsafeRetry.
   */
  public async confirmRecoveryFailureAndRetry(
    sessionId?: string,
    options?: { forceUnsafeRetry?: boolean; rationale?: string; sessionRevision?: number }
  ): Promise<{ success: boolean; error?: string; code?: string; safetyCategory?: string }> {
    const session = this.activeSession || (await ReplaySessionStorage.getActiveSession());
    if (!session) {
      return { success: false, error: 'No active session found', code: 'NO_SESSION' };
    }
    if (sessionId && session.sessionId !== sessionId) {
      return { success: false, error: 'Session ID mismatch', code: 'STALE_SESSION' };
    }
    if (options?.sessionRevision !== undefined && session.sessionRevision !== options.sessionRevision) {
      return { success: false, error: 'Session revision mismatch (concurrent update)', code: 'STALE_REVISION' };
    }
    if (session.status !== 'RECOVERY_REQUIRED') {
      return { success: false, error: `Session not in RECOVERY_REQUIRED state (status: ${session.status})`, code: 'INVALID_STATUS' };
    }

    if (!this.workflow) {
      this.workflow = await WorkflowStorage.getWorkflowById(session.workflowId);
      if (!this.workflow) {
        return { success: false, error: 'Workflow not found', code: 'WORKFLOW_NOT_FOUND' };
      }
    }

    const currentStep = this.workflow.steps[session.currentStepIndex];
    const safety = currentStep ? classifyActionSafety(currentStep) : 'EXTERNAL_SIDE_EFFECT';

    if ((safety === 'EXTERNAL_SIDE_EFFECT' || safety === 'TOGGLE_STATE') && !options?.forceUnsafeRetry) {
      const err = 'Unsafe action retry blocked: Explicit user authorization (forceUnsafeRetry) required to retry side-effecting action.';
      session.lastError = err;
      session.lastErrorCode = 'UNSAFE_RETRY_UNAUTHORIZED';
      await ReplaySessionStorage.saveSession(session);
      this.broadcastStatusChange();
      return {
        success: false,
        error: err,
        code: 'UNSAFE_RETRY_UNAUTHORIZED',
        safetyCategory: safety,
      };
    }

    if (!session.recoveryContext) {
      session.recoveryContext = {
        interruptedStepIndex: session.currentStepIndex,
        interruptedActionId: session.currentActionId || '',
        safetyCategory: safety,
        reason: session.lastError || 'Outcome uncertain',
        evidence: [],
        history: [],
      };
    }

    const decision: RecoveryDecision = {
      id: `DEC_${Date.now()}_retry`,
      decisionType: 'CONFIRM_FAILURE_RETRY',
      sessionId: session.sessionId,
      workflowId: session.workflowId,
      sessionRevision: session.sessionRevision,
      stepIndex: session.currentStepIndex,
      actionId: session.currentActionId || '',
      timestamp: Date.now(),
      authorizedByUser: true,
      forceUnsafeRetry: !!options?.forceUnsafeRetry,
      recordIndex: session.datasetState?.currentRecordIndex,
      rationale: options?.rationale || 'User confirmed failure and authorized retry attempt',
    };

    if (session.recoveryContext) {
      session.recoveryContext.history.push(decision);
      session.recoveryContext.evidence.push({
        id: `EVD_${Date.now()}_user_retry`,
        type: 'user_confirmation',
        timestamp: Date.now(),
        stepIndex: session.currentStepIndex,
        actionId: session.currentActionId || '',
        result: 'FAILURE',
        description: options?.rationale || 'User confirmed failure of original attempt; authorized redispatch',
        source: 'USER_CONFIRMATION',
        isUserProvided: true,
      });
    }

    session.attemptCount = (session.attemptCount || 0) + 1;
    session.currentActionId = `${session.sessionId}_step${session.currentStepIndex}_attempt${session.attemptCount}`;
    session.status = 'WAITING';
    session.actionState = 'NOT_STARTED';
    session.lastError = null;
    session.lastErrorCode = null;

    ReplaySessionStorage.appendEvent(
      session,
      'RECOVERY_DECISION_PROCESSED',
      `User authorized retry for step ${session.currentStepIndex + 1} (Attempt ${session.attemptCount + 1}). Redispatching.`
    );

    this.activeSessionId = session.sessionId;
    this.abortController = new AbortController();
    this.activeSession = await ReplaySessionStorage.saveSession(session);
    this.broadcastStatusChange();

    void this.executeNextStep();
    return { success: true };
  }

  /**
   * Main step execution loop with persistent checkpoints.
   */
  private async executeNextStep(): Promise<void> {
    if (!this.activeSession || !this.workflow) return;
    if (!this.activeSessionId || this.activeSessionId !== this.activeSession.sessionId) return;

    // Check cancellation
    if (
      this.activeSession.cancellationRequested ||
      this.activeSession.status === 'CANCELLED' ||
      this.abortController?.signal.aborted
    ) {
      console.log('[ReplayOrchestrator] Execution halted: session cancelled.');
      return;
    }

    // Check completion
    if (this.activeSession.currentStepIndex >= this.workflow.steps.length) {
      if (this.activeSession.datasetState) {
        await this.handleDatasetRecordCompletion();
        return;
      }

      console.log(
        `[ReplayOrchestrator] Session ${this.activeSession.sessionId} completed all ${this.workflow.steps.length} steps!`
      );
      this.activeSession.status = 'COMPLETED';
      this.activeSession.actionState = 'NOT_STARTED';
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'SESSION_COMPLETED',
        'All steps executed successfully'
      );

      if (this.activeSession.targetTabId) {
        chrome.tabs
          .sendMessage(this.activeSession.targetTabId, { type: 'HIDE_REPLAY_INDICATOR' })
          .catch(() => {});
      }

      this.recordExecutionHistory('SUCCESS');
      await ReplaySessionStorage.clearActiveSession('COMPLETED');
      this.broadcastStatusChange();
      chrome.runtime
        .sendMessage({ type: 'REPLAY_FINISHED', workflowId: this.workflow.id })
        .catch(() => {});
      this.activeSession = null;
      this.workflow = null;
      return;
    }

    // Check paused / recovery state
    if (
      this.activeSession.status === 'PAUSED' ||
      this.activeSession.status === 'RECOVERY_REQUIRED'
    ) {
      return;
    }

    // Centralized execution budget enforcement across all steps, retries, conditional branches, and records
    this.activeSession.stepExecutionCount = (this.activeSession.stepExecutionCount || 0) + 1;
    this.activeSession.totalStepExecutionCount = (this.activeSession.totalStepExecutionCount || 0) + 1;
    const maxBudget = this.activeSession.maxStepBudget || this.workflow.settings?.maxStepBudget || 500;
    const totalMaxBudget = maxBudget * Math.max(1, (this.activeSession.datasetState?.totalRecords || 1)) * 2;

    if (this.activeSession.stepExecutionCount > maxBudget || this.activeSession.totalStepExecutionCount > totalMaxBudget) {
      const err = `Execution budget exceeded (${this.activeSession.stepExecutionCount > maxBudget ? maxBudget : totalMaxBudget} steps). Possible infinite loop or runaway replay.`;
      console.error('[ReplayOrchestrator]', err);
      this.activeSession.status = 'FAILED';
      this.activeSession.actionState = 'FAILED';
      this.activeSession.lastError = err;
      this.activeSession.lastErrorCode = 'EXECUTION_BUDGET_EXCEEDED';
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'EXECUTION_BUDGET_EXCEEDED',
        err
      );
      this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
      this.broadcastStatusChange();
      return;
    }

    const stepIndex = this.activeSession.currentStepIndex;
    const step = this.workflow.steps[stepIndex];

    // Handle condition step locally without browser dispatch
    if (step.type === 'condition') {
      await this.executeConditionStep(step, stepIndex);
      return;
    }

    const safetyCategory = classifyActionSafety(step);
    if (
      (safetyCategory === 'EXTERNAL_SIDE_EFFECT' || safetyCategory === 'TOGGLE_STATE') &&
      this.activeSession.datasetState
    ) {
      this.activeSession.datasetState.hasUnsafeActionExecutedInCurrentRecord = true;
    }

    const preparedStep = this.prepareStepVariables(step);

    // =========================================================================
    // CHECKPOINT 1: PREPARE STEP
    // =========================================================================
    const actionId = `${this.activeSession.sessionId}_step${stepIndex}_attempt${this.activeSession.attemptCount}`;
    this.activeSession.status = 'WAITING';
    this.activeSession.actionState = 'PREPARING';
    this.activeSession.currentActionId = actionId;

    ReplaySessionStorage.appendEvent(
      this.activeSession,
      'STEP_PREPARED',
      `Prepared ${step.type.toUpperCase()} action for step ${stepIndex + 1}`
    );
    this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
    if (this.isExecutionAborted()) {
      this.activeSession = null;
      return;
    }
    this.broadcastStatusChange();

    try {
      let currentTab = await this.getTargetTab();
      if (this.isExecutionAborted()) {
        this.activeSession = null;
        return;
      }
      if (!currentTab || !currentTab.id) {
        throw new Error('No active browser tab found for replay');
      }

      // Initial step navigation if URL is fundamentally different
      if (stepIndex === 0 && preparedStep.url && currentTab.url && currentTab.id) {
        if (!isSafeUrl(preparedStep.url)) {
          throw new Error(`Cannot navigate to unsafe URL scheme: ${preparedStep.url}`);
        }
        try {
          const currentUrlObj = new URL(currentTab.url);
          const targetUrlObj = new URL(preparedStep.url);
          const isDifferentSite =
            currentUrlObj.origin !== targetUrlObj.origin ||
            currentTab.url.startsWith('chrome://') ||
            currentTab.url.startsWith('about:');

          if (isDifferentSite) {
            console.log(`[ReplayOrchestrator] Opening starting URL: ${preparedStep.url}`);
            this.activeSession.status = 'NAVIGATING';
            this.activeSession.navigationPending = true;
            ReplaySessionStorage.appendEvent(
              this.activeSession,
              'NAVIGATION_STARTED',
              `Navigating to initial URL: ${preparedStep.url}`
            );
            this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);

            await chrome.tabs.update(currentTab.id, { url: preparedStep.url });
            await this.waitForTabLoad(currentTab.id, 20000, this.abortController?.signal);
            await WaitManager.wait(300, { signal: this.abortController?.signal });

            this.activeSession.navigationPending = false;
            currentTab = (await this.getTargetTab()) || currentTab;
          }
        } catch (e: unknown) {
          console.warn('[ReplayOrchestrator] Initial URL check warning:', e);
        }
      }

      // =======================================================================
      // CHECKPOINT 2: DISPATCH ACTION
      // =======================================================================
      let stepSuccess = false;
      let lastExecutionError: unknown = null;
      let attempts = 0;

      while (
        !this.isExecutionAborted() &&
        !stepSuccess &&
        attempts < 15
      ) {
        if (this.isExecutionAborted()) {
          this.activeSession = null;
          return;
        }

        const activeTab = await this.getTargetTab();
        if (this.isExecutionAborted()) {
          this.activeSession = null;
          return;
        }

        if (!activeTab || !activeTab.id) {
          await WaitManager.wait(300, { signal: this.abortController?.signal });
          attempts++;
          continue;
        }

        // Wait if tab is loading
        if (activeTab.status === 'loading') {
          this.activeSession!.status = 'NAVIGATING';
          await this.waitForTabLoad(activeTab.id, 20000, this.abortController?.signal);
          await WaitManager.wait(200, { signal: this.abortController?.signal });
          if (this.isExecutionAborted()) {
            this.activeSession = null;
            return;
          }
        }

        this.activeSession!.status = 'RUNNING';
        this.activeSession!.actionState = 'DISPATCHING';
        this.activeSession!.attemptCount = attempts;
        ReplaySessionStorage.appendEvent(
          this.activeSession!,
          'ACTION_DISPATCH_STARTED',
          `Dispatching attempt ${attempts + 1} for step ${stepIndex + 1}`
        );
        this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession!);
        if (this.isExecutionAborted()) {
          this.activeSession = null;
          return;
        }

        try {
          const result = await chrome.tabs.sendMessage(activeTab.id, {
            type: 'EXECUTE_STEP',
            payload: {
              step: preparedStep,
              speedMultiplier: this.activeSession.speedMultiplier,
              index: stepIndex + 1,
              total: this.workflow.steps.length,
              sessionId: this.activeSession.sessionId,
              actionId,
              datasetInfo: this.activeSession.datasetState
                ? {
                    recordIndex: this.activeSession.datasetState.currentRecordIndex + 1,
                    totalRecords: this.activeSession.datasetState.totalRecords,
                  }
                : undefined,
            },
          });

          if (result?.verification) {
            this.activeSession.lastVerificationResult = result.verification;
            if (step.id) {
              this.stepVerifications.set(step.id, result.verification);
            }
          }

          if (result?.extractedValue && this.variableContext) {
            this.variableContext.setExtracted(
              result.extractedValue.variableName,
              result.extractedValue.value,
              step.extraction?.allowOverwrite ?? true
            );
            this.activeSession.variables = this.variableContext.getAllVariables();
            this.activeSession.extractedVariables = {
              ...(this.activeSession.extractedVariables || {}),
              [result.extractedValue.variableName]: result.extractedValue.value,
            };
            ReplaySessionStorage.appendEvent(
              this.activeSession,
              'OUTPUT_EXTRACTED',
              `Extracted "${result.extractedValue.variableName}" = "${step.sensitive ? '••••••••' : String(result.extractedValue.value)}"`
            );
          }

          if (result && result.success) {
            stepSuccess = true;
            ReplaySessionStorage.appendEvent(
              this.activeSession,
              'ACTION_ACKNOWLEDGED',
              `Content script completed action for step ${stepIndex + 1}`
            );
            break;
          } else if (result?.verification?.status === 'OUTCOME_UNKNOWN') {
            console.warn(
              `[ReplayOrchestrator] Outcome of action ${actionId} is uncertain. Marking RECOVERY_REQUIRED.`
            );
            this.activeSession.status = 'RECOVERY_REQUIRED';
            this.activeSession.actionState = 'OUTCOME_UNKNOWN';
            this.activeSession.lastError =
              result.verification.recoveryRecommendation ||
              result.verification.diagnosticInfo ||
              'Action outcome is uncertain. Replay paused to avoid repeating potentially unsafe action.';

            const safety = classifyActionSafety(step);
            this.activeSession.recoveryContext = {
              interruptedStepIndex: stepIndex,
              interruptedActionId: actionId,
              safetyCategory: safety,
              reason: this.activeSession.lastError || 'Action outcome is uncertain',
              evidence: [
                {
                  id: `EVD_${Date.now()}_init`,
                  type: 'dom_postcondition',
                  timestamp: Date.now(),
                  stepIndex,
                  actionId,
                  result: 'UNCERTAIN',
                  description: result.verification?.diagnosticInfo || 'Automated verification returned OUTCOME_UNKNOWN',
                  source: 'AUTOMATED_CHECK',
                  isUserProvided: false,
                  details: result.verification ? { method: result.verification.method, expectedCondition: result.verification.expectedCondition } : undefined,
                },
              ],
              history: [],
            };

            ReplaySessionStorage.appendEvent(
              this.activeSession,
              'OUTCOME_UNCERTAIN',
              `Step ${stepIndex + 1} outcome uncertain. User recovery required.`
            );
            this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
            this.broadcastStatusChange();

            if (this.activeSession.targetTabId) {
              chrome.tabs
                .sendMessage(this.activeSession.targetTabId, {
                  type: 'SHOW_RECOVERY_HUD',
                  payload: {
                    session: this.activeSession,
                    step,
                    message: this.activeSession.lastError,
                  },
                })
                .catch(() => {});
            }
            return;
          } else {
            // Check if verification explicitly failed
            if (result?.verification?.status === 'NOT_VERIFIED') {
              const isIdempotentRetry =
                result.verification.retryEligibility === 'SAFE_ACTION_RETRY';
              if (isIdempotentRetry && attempts < 14) {
                console.log(
                  `[ReplayOrchestrator] Idempotent step ${stepIndex + 1} not verified. Safe to retry attempt ${attempts + 2}.`
                );
                ReplaySessionStorage.appendEvent(
                  this.activeSession,
                  'POSTCONDITION_FAILED',
                  `Step ${stepIndex + 1} postcondition not met. Retrying idempotent action.`
                );
                await WaitManager.wait(300, { signal: this.abortController?.signal });
                attempts++;
                continue;
              }

              if (preparedStep.verification?.pauseOnFailure) {
                this.activeSession.status = 'PAUSED';
                this.activeSession.lastError =
                  result.verification.diagnosticInfo || 'Step postcondition failed. Workflow paused.';
                ReplaySessionStorage.appendEvent(
                  this.activeSession,
                  'SESSION_PAUSED',
                  `Verification failed for step ${stepIndex + 1}. Workflow paused per configuration.`
                );
                this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
                this.broadcastStatusChange();
                return;
              }
            }

            const err = new Error(result?.error || 'Element execution failed');
            if (result?.code) (err as any).code = result.code;
            throw err;
          }
        } catch (err: any) {
          lastExecutionError = err;
          const msg = err?.message || '';

          // Stop on fatal target errors
          if (
            msg.includes('Could not find') ||
            msg.includes('TARGET_NOT_FOUND') ||
            msg.includes('TARGET_AMBIGUOUS') ||
            msg.includes('Ambiguous target') ||
            msg.includes('ELEMENT_NOT_INTERACTABLE') ||
            msg.includes('CONTEXT_MISMATCH')
          ) {
            throw err;
          }

          // Check if page navigated during interaction
          const isNavigation =
            msg.includes('message port closed') ||
            msg.includes('Receiving end does not exist') ||
            msg.includes('Frame was removed') ||
            msg.includes('Could not establish connection');

          if (isNavigation) {
            console.warn(
              `[ReplayOrchestrator] Connection closed during action dispatch (navigation in progress): ${msg}`
            );
            this.activeSession.status = 'NAVIGATING';
            this.activeSession.navigationPending = true;
            ReplaySessionStorage.appendEvent(
              this.activeSession,
              'NAVIGATION_STARTED',
              `Page navigating following action ${step.type}`
            );
            this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);

            await WaitManager.wait(300, { signal: this.abortController?.signal });
            const freshTab = await this.getTargetTab();
            if (freshTab && freshTab.id && freshTab.status === 'loading') {
              await this.waitForTabLoad(freshTab.id, 20000, this.abortController?.signal);
              await WaitManager.wait(200, { signal: this.abortController?.signal });
              this.activeSession.navigationPending = false;

              // Action successfully triggered page navigation!
              if (
                preparedStep.type === 'click' ||
                preparedStep.type === 'keydown' ||
                preparedStep.type === 'keypress'
              ) {
                stepSuccess = true;
                break;
              }
            }
            attempts++;
            continue;
          }

          await WaitManager.wait(300, { signal: this.abortController?.signal });
          attempts++;
        }
      }

      if (!stepSuccess) {
        throw lastExecutionError || new Error('Step execution failed after multiple attempts');
      }

      if (this.isExecutionAborted()) {
        this.activeSession = null;
        return;
      }

      // =======================================================================
      // CHECKPOINT 3: POSTCONDITION VERIFIED
      // =======================================================================
      this.activeSession!.actionState = 'VERIFIED';
      const verifyMethod = this.activeSession!.lastVerificationResult?.method || 'acknowledged';
      ReplaySessionStorage.appendEvent(
        this.activeSession!,
        'POSTCONDITION_VERIFIED',
        `Step ${stepIndex + 1} verified via ${verifyMethod}`
      );

      // =======================================================================
      // CHECKPOINT 4: ADVANCE STEP INDEX
      // =======================================================================
      this.activeSession!.lastCompletedStepIndex = stepIndex;
      this.activeSession!.currentStepIndex = stepIndex + 1;
      this.activeSession!.actionState = 'NOT_STARTED';
      this.activeSession!.currentActionId = null;
      this.activeSession!.attemptCount = 0;
      ReplaySessionStorage.appendEvent(
        this.activeSession!,
        'STEP_CHECKPOINT_SAVED',
        `Advanced to step ${this.activeSession!.currentStepIndex + 1}/${this.workflow.steps.length}`
      );
      this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession!);
      this.broadcastStatusChange();

      // Step pacing delay
      const delayMs = Math.max(100, 600 / this.activeSession.speedMultiplier);
      await WaitManager.wait(delayMs, { signal: this.abortController?.signal });

      void this.executeNextStep();
    } catch (e: any) {
      if (this.isExecutionAborted() || !this.activeSession) {
        this.activeSession = null;
        return;
      }

      const errorMsg = e.message || 'Unknown error occurred during replay.';
      const errorCode =
        e.code ||
        (errorMsg.includes('TARGET_AMBIGUOUS') ? 'TARGET_AMBIGUOUS' : 'EXECUTION_FAILED');

      console.error(
        `[ReplayOrchestrator] Replay failed at step ${this.activeSession.currentStepIndex + 1}:`,
        errorMsg
      );

      if (this.activeSession.datasetState) {
        const dsState = this.activeSession.datasetState;
        dsState.failedRecords.push({
          index: dsState.currentRecordIndex,
          error: errorMsg,
          stepIndex: this.activeSession.currentStepIndex,
          outcomeUnknown: this.activeSession.actionState === 'OUTCOME_UNKNOWN',
          executedUnsafeStep: dsState.hasUnsafeActionExecutedInCurrentRecord || false,
        });
        ReplaySessionStorage.appendEvent(
          this.activeSession,
          'DATASET_RECORD_FAILED',
          `Record ${dsState.currentRecordIndex + 1} failed: ${errorMsg}`
        );
      }

      this.activeSession.status = 'FAILED';
      this.activeSession.actionState = 'FAILED';
      this.activeSession.lastError = errorMsg;
      this.activeSession.lastErrorCode = errorCode;
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'SESSION_FAILED',
        errorMsg,
        errorCode
      );

      let failureCategory: FailureCategory = 'UNEXPECTED';
      if (errorCode === 'BUDGET_EXCEEDED') failureCategory = 'BUDGET_EXCEEDED';
      else if (errorCode === 'TIMEOUT' || errorMsg.includes('timed out')) failureCategory = 'TIMEOUT';
      else if (errorCode === 'TARGET_NOT_FOUND' || errorMsg.includes('Target not found')) failureCategory = 'TARGET_NOT_FOUND';
      else if (errorCode === 'VERIFICATION_FAILED') failureCategory = 'VERIFICATION_FAILED';
      else if (errorCode === 'SIDE_EFFECT_REFUSED') failureCategory = 'SIDE_EFFECT_REFUSED';
      this.recordExecutionHistory('FAILED', failureCategory, errorMsg);

      this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
      this.broadcastStatusChange();

      // Notify content script HUD if tab is alive
      const tab = await this.getTargetTab();
      if (tab?.id) {
        if (tab.status === 'loading') {
          await this.waitForTabLoad(tab.id, 5000).catch(() => {});
        }
        chrome.tabs
          .sendMessage(tab.id, {
            type: 'SHOW_REPLAY_ERROR',
            payload: { error: errorMsg, code: errorCode },
          })
          .catch(() => {});
      }
    }
  }

  private broadcastStatusChange(): void {
    if (!this.activeSession) return;
    chrome.runtime
      .sendMessage({
        type: 'REPLAY_STATUS_CHANGED',
        payload: { session: { ...this.activeSession } },
      })
      .catch(() => {});
  }

  private async getTargetTab(): Promise<chrome.tabs.Tab | null> {
    if (this.activeSession?.targetTabId) {
      try {
        const tab = await chrome.tabs.get(this.activeSession.targetTabId);
        if (tab && tab.id) return tab;
      } catch {
        console.warn(
          `[ReplayOrchestrator] Target tab ${this.activeSession.targetTabId} not available, falling back.`
        );
      }
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id) {
        if (this.activeSession) this.activeSession.targetTabId = tab.id;
        return tab;
      }
      const [anyActive] = await chrome.tabs.query({ active: true });
      if (anyActive?.id) {
        if (this.activeSession) this.activeSession.targetTabId = anyActive.id;
        return anyActive;
      }
    } catch {}

    return null;
  }

  private waitForTabLoad(
    tabId: number,
    timeoutMs = 20000,
    signal?: AbortSignal
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new WaitError('Tab load cancelled', 'WAIT_CANCELLED', {
            condition: 'waitForTabLoad',
            startTimestamp: Date.now(),
            elapsedMs: 0,
            timeoutMs,
            status: 'cancelled',
            errorCode: 'WAIT_CANCELLED',
          })
        );
        return;
      }

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(false);
          return;
        }
        if (tab.status === 'complete') {
          resolve(true);
          return;
        }

        let isDone = false;
        const cleanup = () => {
          isDone = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          signal?.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
          if (isDone) return;
          cleanup();
          reject(
            new WaitError('Tab load cancelled', 'WAIT_CANCELLED', {
              condition: 'waitForTabLoad',
              startTimestamp: Date.now(),
              elapsedMs: 0,
              timeoutMs,
              status: 'cancelled',
              errorCode: 'WAIT_CANCELLED',
            })
          );
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimeout(() => {
          if (isDone) return;
          cleanup();
          resolve(false);
        }, timeoutMs);

        const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') {
            cleanup();
            resolve(true);
          }
        };

        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }

  private async executeConditionStep(step: WorkflowStep, stepIndex: number): Promise<void> {
    if (!this.activeSession || !this.workflow || !step.condition) return;

    if (this.isExecutionAborted()) {
      this.activeSession = null;
      return;
    }

    if (!this.variableContext) {
      this.variableContext = new VariableContext(
        this.workflow.variables || [],
        this.activeSession.variables,
        {},
        {
          _stepIndex: stepIndex + 1,
          _recordIndex: this.activeSession.datasetState?.currentRecordIndex ?? 0,
          _workflowId: this.workflow.id,
          _sessionId: this.activeSession.sessionId,
        }
      );
    }
    this.variableContext.setSystemVariable('_stepIndex', stepIndex + 1);

    const evalResult = ConditionEvaluator.evaluate(
      step.condition,
      this.variableContext,
      this.activeSession.lastVerificationResult,
      this.stepVerifications
    );

    this.activeSession.lastConditionResult = {
      stepIndex,
      matched: evalResult.matched,
      targetBranch: evalResult.targetBranch,
      operator: evalResult.operator,
      actualValue: evalResult.actualValue,
      expectedValue: evalResult.expectedValue,
    };

    ReplaySessionStorage.appendEvent(
      this.activeSession,
      'CONDITION_EVALUATED',
      evalResult.diagnosticInfo
    );

    // Determine target step index
    let nextStepIndex: number;
    if (evalResult.targetBranch === 'next') {
      nextStepIndex = stepIndex + 1;
    } else if (evalResult.targetBranch === 'end') {
      nextStepIndex = this.workflow.steps.length;
    } else {
      const targetIdx = this.workflow.steps.findIndex((s) => s.id === evalResult.targetBranch);
      if (targetIdx === -1) {
        const err = `Invalid branch target step ID "${evalResult.targetBranch}" not found in workflow`;
        console.error('[ReplayOrchestrator]', err);
        this.activeSession.status = 'FAILED';
        this.activeSession.actionState = 'FAILED';
        this.activeSession.lastError = err;
        this.activeSession.lastErrorCode = 'INVALID_BRANCH_TARGET';
        ReplaySessionStorage.appendEvent(
          this.activeSession,
          'SESSION_FAILED',
          err,
          'INVALID_BRANCH_TARGET'
        );
        this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
        this.broadcastStatusChange();
        return;
      }
      nextStepIndex = targetIdx;
    }

    ReplaySessionStorage.appendEvent(
      this.activeSession,
      'BRANCH_TAKEN',
      `Condition branched to step ${nextStepIndex + 1}${evalResult.targetBranch === 'end' ? ' (END)' : ''}`
    );

    this.activeSession.lastCompletedStepIndex = stepIndex;
    this.activeSession.currentStepIndex = nextStepIndex;
    this.activeSession.actionState = 'NOT_STARTED';
    this.activeSession.currentActionId = null;
    this.activeSession.attemptCount = 0;

    this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
    this.broadcastStatusChange();

    // Small delay between branch steps
    const delayMs = Math.max(50, 150 / this.activeSession.speedMultiplier);
    await WaitManager.wait(delayMs, { signal: this.abortController?.signal });

    void this.executeNextStep();
  }

  private async handleDatasetRecordCompletion(): Promise<void> {
    if (!this.activeSession || !this.activeSession.datasetState || !this.workflow) return;

    const dsState = this.activeSession.datasetState;
    const currentRecordIdx = dsState.currentRecordIndex;

    if (!dsState.completedRecords.includes(currentRecordIdx)) {
      dsState.completedRecords.push(currentRecordIdx);
    }

    ReplaySessionStorage.appendEvent(
      this.activeSession,
      'DATASET_RECORD_COMPLETED',
      `Record ${currentRecordIdx + 1}/${dsState.totalRecords} completed successfully`
    );

    const nextRecordIdx = currentRecordIdx + 1;
    if (
      nextRecordIdx < dsState.totalRecords &&
      this.activeDataset &&
      nextRecordIdx < this.activeDataset.records.length
    ) {
      dsState.currentRecordIndex = nextRecordIdx;
      dsState.hasUnsafeActionExecutedInCurrentRecord = false;
      this.activeSession.currentStepIndex = 0;
      this.activeSession.lastCompletedStepIndex = -1;
      this.activeSession.stepExecutionCount = 0;

      // Create fresh isolated variable context for next record
      if (this.baseVariableContext) {
        this.variableContext = this.baseVariableContext.createRecordContext(
          this.activeDataset.records[nextRecordIdx],
          nextRecordIdx
        );
      } else {
        this.variableContext = new VariableContext(
          this.workflow.variables || [],
          this.variables,
          this.activeDataset.records[nextRecordIdx],
          {
            _stepIndex: 1,
            _recordIndex: nextRecordIdx,
            _timestamp: Date.now(),
            _workflowId: this.workflow.id,
            _sessionId: this.activeSession.sessionId,
          }
        );
      }
      this.activeSession.variables = this.variableContext.getAllVariables();
      this.activeSession.extractedVariables = {};

      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'DATASET_RECORD_STARTED',
        `Starting record ${nextRecordIdx + 1} of ${dsState.totalRecords}`
      );

      this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
      this.broadcastStatusChange();

      // Pacing delay between records
      await WaitManager.wait(500, { signal: this.abortController?.signal });
      void this.executeNextStep();
    } else {
      // All records completed!
      dsState.status = 'COMPLETED';
      this.activeSession.status = 'COMPLETED';
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'DATASET_COMPLETED',
        `All ${dsState.totalRecords} dataset records processed (${dsState.completedRecords.length} succeeded, ${dsState.failedRecords.length} failed)`
      );

      if (this.activeSession.targetTabId) {
        chrome.tabs
          .sendMessage(this.activeSession.targetTabId, { type: 'HIDE_REPLAY_INDICATOR' })
          .catch(() => {});
      }

      this.recordExecutionHistory('SUCCESS');
      await ReplaySessionStorage.clearActiveSession('COMPLETED');
      this.broadcastStatusChange();
      chrome.runtime
        .sendMessage({ type: 'REPLAY_FINISHED', workflowId: this.workflow.id })
        .catch(() => {});
      this.activeSession = null;
      this.workflow = null;
      this.activeDataset = null;
    }
  }

  public async skipDatasetRecord(sessionId?: string): Promise<boolean> {
    if (!this.activeSession || (sessionId && this.activeSession.sessionId !== sessionId)) {
      return false;
    }
    if (!this.activeSession.datasetState) return false;

    const dsState = this.activeSession.datasetState;
    const currentRecordIdx = dsState.currentRecordIndex;
    if (!dsState.skippedRecords.includes(currentRecordIdx)) {
      dsState.skippedRecords.push(currentRecordIdx);
    }
    await this.handleDatasetRecordCompletion();
    return true;
  }

  public async retryDatasetRecord(
    sessionId?: string,
    options?: { forceUnsafeRetry?: boolean }
  ): Promise<boolean> {
    if (!this.activeSession || (sessionId && this.activeSession.sessionId !== sessionId)) {
      return false;
    }
    if (!this.activeSession.datasetState) return false;
    const dsState = this.activeSession.datasetState;
    if (!this.activeDataset && dsState.records && dsState.records.length > 0) {
      this.activeDataset = {
        records: dsState.records,
        columns: Object.keys(dsState.records[0] || {}),
        rowCount: dsState.records.length,
        fingerprint: dsState.fingerprint,
      };
    }
    if (!this.activeDataset) return false;
    const currentRecordIdx = dsState.currentRecordIndex;

    // Safety check: if current record executed an unsafe action with external side effects,
    // require explicit user recovery confirmation (forceUnsafeRetry)
    if (dsState.hasUnsafeActionExecutedInCurrentRecord && !options?.forceUnsafeRetry) {
      console.warn(
        `[ReplayOrchestrator] Record ${currentRecordIdx + 1} previously executed an unsafe action. Blind restart at step 0 blocked without forceUnsafeRetry.`
      );
      this.activeSession.status = 'RECOVERY_REQUIRED';
      this.activeSession.lastError =
        'Record restart at step 0 blocked: Record executed non-idempotent action with side effects. Explicit confirmation (forceUnsafeRetry) required.';
      this.activeSession.lastErrorCode = 'UNSAFE_RECORD_RETRY_BLOCKED';
      ReplaySessionStorage.appendEvent(
        this.activeSession,
        'SESSION_RECOVERY_REQUIRED',
        'Record restart at step 0 blocked: requires forceUnsafeRetry'
      );
      this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
      this.broadcastStatusChange();
      return false;
    }

    dsState.hasUnsafeActionExecutedInCurrentRecord = false;
    this.activeSession.currentStepIndex = 0;
    this.activeSession.lastCompletedStepIndex = -1;
    this.activeSession.status = 'RUNNING';
    this.activeSession.actionState = 'NOT_STARTED';
    this.activeSession.lastError = null;
    this.activeSession.lastErrorCode = null;

    if (this.baseVariableContext) {
      this.variableContext = this.baseVariableContext.createRecordContext(
        this.activeDataset.records[currentRecordIdx],
        currentRecordIdx
      );
    } else {
      this.variableContext = new VariableContext(
        this.workflow?.variables || [],
        this.variables,
        this.activeDataset.records[currentRecordIdx]
      );
    }

    this.activeSession.variables = this.variableContext.getAllVariables();
    this.activeSession = await ReplaySessionStorage.saveSession(this.activeSession);
    this.broadcastStatusChange();

    void this.executeNextStep();
    return true;
  }

  private prepareStepVariables(step: WorkflowStep): WorkflowStep {
    const cloned = { ...step };
    const vars = this.activeSession?.variables || this.variables;

    if (!this.variableContext && vars) {
      this.variableContext = new VariableContext(
        this.workflow?.variables || [],
        vars,
        {},
        {
          _stepIndex: step.sequence,
          _recordIndex: this.activeSession?.datasetState?.currentRecordIndex ?? 0,
          _workflowId: this.workflow?.id,
          _sessionId: this.activeSession?.sessionId,
        }
      );
    }

    if (this.variableContext) {
      this.variableContext.setSystemVariable('_stepIndex', step.sequence);
    }

    if (cloned.value && typeof cloned.value === 'string') {
      cloned.value = this.variableContext
        ? this.variableContext.interpolate(cloned.value)
        : cloned.value.replace(/{{([^}]+)}}/g, (_, varName) =>
            vars[varName] !== undefined ? String(vars[varName]) : `{{${varName}}}`
          );
    }

    if (cloned.url && typeof cloned.url === 'string' && cloned.url.includes('{{')) {
      cloned.url = this.variableContext
        ? this.variableContext.interpolate(cloned.url)
        : cloned.url;
    }

    return cloned;
  }

  public static getInstance(): ReplayOrchestrator {
    return orchestrator;
  }
}

export const orchestrator = new ReplayOrchestrator();
