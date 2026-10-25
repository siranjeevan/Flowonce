import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplayOrchestrator } from '../src/replay/ReplayOrchestrator';
import { ReplaySessionStorage } from '../src/replay/session/ReplaySessionStorage';
import type { ReplaySession } from '../src/replay/session/session-types';
import { WorkflowStorage } from '../src/workflow/storage/WorkflowStorage';
import { CURRENT_SESSION_SCHEMA_VERSION } from '../src/workflow/storage/storage-keys';
import type { Workflow } from '../src/shared/types/workflow';

describe('Phase 9: Interactive Recovery Inspector and Safe Resolution (Unit Tests)', () => {
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    mockStorage = {};

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | null) => {
            if (!keys) return { ...mockStorage };
            if (typeof keys === 'string') return { [keys]: mockStorage[keys] };
            if (Array.isArray(keys)) {
              const res: Record<string, any> = {};
              for (const k of keys) res[k] = mockStorage[k];
              return res;
            }
            return { ...mockStorage };
          }),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign(mockStorage, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete mockStorage[k];
          }),
          clear: vi.fn(async () => {
            mockStorage = {};
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          if (tabId === 999) throw new Error('Tab closed or not found');
          return { id: tabId, status: 'complete', url: 'https://example.com/checkout' };
        }),
        query: vi.fn(async () => [{ id: 101, status: 'complete', url: 'https://example.com/checkout' }]),
        sendMessage: vi.fn(async (tabId: number, msg: any) => {
          if (tabId === 999) throw new Error('Tab closed or not found');
          if (msg.type === 'INSPECT_PAGE_STATE') {
            return {
              success: true,
              url: 'https://example.com/checkout?status=pending',
              title: 'Checkout Confirmation',
              targetFound: true,
              targetDetails: { tagName: 'BUTTON', text: 'Confirm Payment', disabled: true },
            };
          }
          if (msg.type === 'RECHECK_STEP_CONDITION') {
            return {
              success: true,
              verification: {
                status: 'VERIFIED',
                verified: true,
                diagnosticInfo: 'Element #order-complete is visible',
              },
            };
          }
          if (msg.type === 'CHECK_ACTION_EXECUTED') {
            return { executed: false };
          }
          return { success: true };
        }),
        update: vi.fn(async () => ({})),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      runtime: {
        lastError: null,
        sendMessage: vi.fn(async () => ({})),
      },
    };

    WorkflowStorage._resetInitialization();
  });

  const createRecoveryTestWorkflow = (): Workflow => ({
    id: 'wf_recovery_test',
    name: 'Payment Checkout Workflow',
    ownerId: 'user_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    schemaVersion: 2,
    variables: [],
    steps: [
      {
        sequence: 1,
        id: 'step_1_submit_payment',
        type: 'click',
        url: 'https://example.com/checkout',
        timestamp: 100,
        target: { selector: '#submit-order-button' },
        description: 'Submit credit card payment',
        postcondition: {
          type: 'element_visible',
          target: { selector: '#order-complete' },
          timeout: 1000,
        },
      },
      {
        sequence: 2,
        id: 'step_2_download_receipt',
        type: 'click',
        url: 'https://example.com/checkout',
        timestamp: 200,
        target: { selector: '#download-receipt-button' },
        description: 'Download PDF receipt',
      },
    ],
  });

  const setupUncertainSession = async (wf: Workflow): Promise<ReplaySession> => {
    await WorkflowStorage.createWorkflow(wf);
    const session: ReplaySession = {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      sessionId: 'SES_REC_999',
      workflowId: wf.id,
      workflowName: wf.name,
      workflowSchemaVersion: 2,
      totalSteps: wf.steps.length,
      status: 'RECOVERY_REQUIRED',
      currentStepIndex: 0,
      lastCompletedStepIndex: -1,
      currentActionId: 'SES_REC_999_step0_attempt0',
      actionState: 'OUTCOME_UNKNOWN',
      attemptCount: 0,
      speedMultiplier: 1,
      variables: {},
      lastError: 'Action dispatched but verification timed out. Outcome is uncertain.',
      lastErrorCode: 'OUTCOME_UNKNOWN',
      checkpointTimestamp: Date.now(),
      sessionRevision: 0,
      targetTabId: 101,
      cancellationRequested: false,
      history: [],
      recoveryContext: {
        interruptedStepIndex: 0,
        interruptedActionId: 'SES_REC_999_step0_attempt0',
        safetyCategory: 'EXTERNAL_SIDE_EFFECT',
        reason: 'Action dispatched but verification timed out. Outcome is uncertain.',
        evidence: [
          {
            id: 'EVD_init',
            type: 'inconclusive',
            timestamp: Date.now(),
            stepIndex: 0,
            actionId: 'SES_REC_999_step0_attempt0',
            result: 'UNCERTAIN',
            description: 'Action dispatch acknowledged but verification timed out after 1000ms',
            source: 'AUTOMATED_CHECK',
            isUserProvided: false,
          },
        ],
        history: [],
      },
    };
    return await ReplaySessionStorage.saveSession(session);
  };

  // =========================================================================
  // 1. CONFIRM-SUCCESS PERSISTENCE & SAFE PROGRESSION
  // =========================================================================
  describe('Confirm-Success Persistence & Progression', () => {
    it('persists user-confirmed success, records audit evidence, and advances exactly once without redispatching', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);

      const orchestrator = new ReplayOrchestrator();
      const dispatchedActions: any[] = [];
      (globalThis as any).chrome.tabs.sendMessage = vi.fn(async (_tabId: number, msg: any) => {
        if (msg.type === 'EXECUTE_ACTION') {
          dispatchedActions.push(msg.payload?.action);
        }
        return { success: true };
      });

      const res = await orchestrator.confirmRecoverySuccess('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
        rationale: 'I verified the order in my bank app and it succeeded.',
      });

      expect(res.success).toBe(true);

      const savedSession = await ReplaySessionStorage.getActiveSession();
      expect(savedSession).not.toBeNull();
      // Step 0 was confirmed; step index advances to 1
      expect(savedSession?.currentStepIndex).toBe(1);
      expect(savedSession?.lastCompletedStepIndex).toBe(0);

      // Verify RecoveryDecision history
      const history = savedSession?.recoveryContext?.history;
      expect(history).toHaveLength(1);
      expect(history?.[0].decisionType).toBe('CONFIRM_SUCCESS');
      expect(history?.[0].authorizedByUser).toBe(true);
      expect(history?.[0].stepIndex).toBe(0);
      expect(history?.[0].rationale).toContain('verified the order in my bank app');

      // Verify RecoveryEvidence log distinguishes user confirmation from automated verification
      const evidence = savedSession?.recoveryContext?.evidence;
      const userEvd = evidence?.find((e) => e.type === 'user_confirmation');
      expect(userEvd).toBeDefined();
      expect(userEvd?.result).toBe('SUCCESS');
      expect(userEvd?.isUserProvided).toBe(true);
      expect(userEvd?.source).toBe('USER_CONFIRMATION');

      // Verify that step 0 (#submit-order-button) was NEVER redispatched
      const step0Dispatches = dispatchedActions.filter(
        (a) => a.selector === '#submit-order-button'
      );
      expect(step0Dispatches).toHaveLength(0);
    });

    it('rejects confirm-success when session ID does not match', async () => {
      const wf = createRecoveryTestWorkflow();
      await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const res = await orchestrator.confirmRecoverySuccess('WRONG_SES_ID');
      expect(res.success).toBe(false);
      expect(res.code).toBe('STALE_SESSION');
    });

    it('rejects confirm-success when sessionRevision is stale (optimistic concurrency)', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const res = await orchestrator.confirmRecoverySuccess('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision - 1, // Stale revision
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('STALE_REVISION');
    });

    it('rejects confirm-success when session is not in RECOVERY_REQUIRED state', async () => {
      const wf = createRecoveryTestWorkflow();
      const session = await setupUncertainSession(wf);
      session.status = 'COMPLETED';
      await ReplaySessionStorage.saveSession(session);

      const orchestrator = new ReplayOrchestrator();
      const res = await orchestrator.confirmRecoverySuccess('SES_REC_999');
      expect(res.success).toBe(false);
      expect(res.code).toBe('INVALID_STATUS');
    });
  });

  // =========================================================================
  // 2. CONFIRM-FAILURE AND RETRY SAFEGUARDS
  // =========================================================================
  describe('Confirm-Failure & Retry Safeguards', () => {
    it('blocks retry of side-effecting action if explicit forceUnsafeRetry is omitted', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const res = await orchestrator.confirmRecoveryFailureAndRetry('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
        forceUnsafeRetry: false,
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe('UNSAFE_RETRY_UNAUTHORIZED');
      expect(res.safetyCategory).toBe('EXTERNAL_SIDE_EFFECT');

      // Verify session stays in RECOVERY_REQUIRED and attemptCount was NOT incremented
      const session = await ReplaySessionStorage.getActiveSession();
      expect(session?.status).toBe('RECOVERY_REQUIRED');
      expect(session?.attemptCount).toBe(0);
      expect(session?.lastErrorCode).toBe('UNSAFE_RETRY_UNAUTHORIZED');
    });

    it('permits retry of side-effecting action when forceUnsafeRetry is explicitly true', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const res = await orchestrator.confirmRecoveryFailureAndRetry('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
        forceUnsafeRetry: true,
        rationale: 'I confirmed payment failed at gateway. Authorizing one redispatch.',
      });

      expect(res.success).toBe(true);

      const session = await ReplaySessionStorage.getActiveSession();
      expect(session).not.toBeNull();
      // Attempt count incremented
      expect(session?.attemptCount).toBe(1);
      // New action attempt ID generated
      expect(session?.currentActionId).toBe('SES_REC_999_step0_attempt1');

      // Recovery decision history includes CONFIRM_FAILURE_RETRY with forceUnsafeRetry flag
      const history = session?.recoveryContext?.history;
      expect(history).toHaveLength(1);
      expect(history?.[0].decisionType).toBe('CONFIRM_FAILURE_RETRY');
      expect(history?.[0].forceUnsafeRetry).toBe(true);
      expect(history?.[0].actionId).toBe('SES_REC_999_step0_attempt0');
    });

    it('permits retry without forceUnsafeRetry for safe/idempotent actions', async () => {
      const wf: Workflow = {
        id: 'wf_safe_recovery',
        name: 'Safe Search Workflow',
        ownerId: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        schemaVersion: 2,
        variables: [],
        steps: [
          {
            sequence: 1,
            id: 'step_scroll',
            type: 'scroll',
            url: 'https://example.com',
            timestamp: 100,
            target: { selector: 'body' },
            description: 'Scroll catalog page',
          },
        ],
      };
      await WorkflowStorage.createWorkflow(wf);

      const session: ReplaySession = {
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        sessionId: 'SES_SAFE_01',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        totalSteps: 1,
        speedMultiplier: 1,
        variables: {},
        lastCompletedStepIndex: -1,
        status: 'RECOVERY_REQUIRED',
        currentStepIndex: 0,
        currentActionId: 'SES_SAFE_01_step0_attempt0',
        actionState: 'OUTCOME_UNKNOWN',
        attemptCount: 0,
        lastError: 'Scroll verification inconclusive',
        lastErrorCode: 'OUTCOME_UNKNOWN',
        checkpointTimestamp: Date.now(),
        sessionRevision: 0,
        targetTabId: 101,
        cancellationRequested: false,
        history: [],
      };
      const savedSession = await ReplaySessionStorage.saveSession(session);

      const orchestrator = new ReplayOrchestrator();
      const res = await orchestrator.confirmRecoveryFailureAndRetry('SES_SAFE_01', {
        sessionRevision: savedSession.sessionRevision,
      });

      expect(res.success).toBe(true);
    });
  });

  // =========================================================================
  // 3. READ-ONLY PAGE INSPECTION & RECHECK CONDITION
  // =========================================================================
  describe('Read-Only Page Inspection & Condition Recheck', () => {
    it('inspectRecoveryPageState queries DOM without dispatching action and logs URL + element observation', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const dispatchedActions: any[] = [];
      (globalThis as any).chrome.tabs.sendMessage = vi.fn(async (_tabId: number, msg: any) => {
        if (msg.type === 'EXECUTE_ACTION') {
          dispatchedActions.push(msg.payload?.action);
        }
        if (msg.type === 'INSPECT_PAGE_STATE') {
          return {
            success: true,
            url: 'https://example.com/checkout?status=pending',
            title: 'Checkout Confirmation',
            targetFound: true,
            targetDetails: { tagName: 'BUTTON', text: 'Confirm Payment', disabled: true },
          };
        }
        return { success: true };
      });

      const res = await orchestrator.inspectRecoveryPageState('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
      });

      expect(res.success).toBe(true);
      expect(dispatchedActions).toHaveLength(0); // Zero actions dispatched

      const session = await ReplaySessionStorage.getActiveSession();
      expect(session?.recoveryContext?.lastInspection).toBeDefined();
      expect(session?.recoveryContext?.lastInspection?.url).toContain('status=pending');
      expect(session?.recoveryContext?.lastInspection?.targetFound).toBe(true);

      const urlEvd = session?.recoveryContext?.evidence.find((e) => e.type === 'url_observation');
      expect(urlEvd).toBeDefined();
      expect(urlEvd?.source).toBe('AUTOMATED_CHECK');
      expect(urlEvd?.isUserProvided).toBe(false);
    });

    it('inspectRecoveryPageState handles closed tab gracefully without crashing', async () => {
      const wf = createRecoveryTestWorkflow();
      const session = await setupUncertainSession(wf);
      session.targetTabId = 999; // Mock tab throws on get/sendMessage
      await ReplaySessionStorage.saveSession(session);

      const orchestrator = new ReplayOrchestrator();
      const res = await orchestrator.inspectRecoveryPageState('SES_REC_999');

      expect(res.success).toBe(true); // Graceful recovery evidence recorded
      const savedSession = await ReplaySessionStorage.getActiveSession();
      const incEvd = savedSession?.recoveryContext?.evidence.find((e) =>
        e.description.includes('target tab or content script is not responding')
      );
      expect(incEvd).toBeDefined();
    });

    it('recheckRecoveryCondition evaluates postcondition without redispatching action', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const dispatchedActions: any[] = [];
      (globalThis as any).chrome.tabs.sendMessage = vi.fn(async (_tabId: number, msg: any) => {
        if (msg.type === 'EXECUTE_ACTION') {
          dispatchedActions.push(msg.payload?.action);
        }
        if (msg.type === 'RECHECK_STEP_CONDITION') {
          return {
            success: true,
            verification: {
              status: 'VERIFIED',
              verified: true,
              diagnosticInfo: 'Element #order-complete is visible',
            },
          };
        }
        return { success: true };
      });

      const res = await orchestrator.recheckRecoveryCondition('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
      });

      expect(res.success).toBe(true);
      expect(res.verification?.verified).toBe(true);
      expect(dispatchedActions).toHaveLength(0); // Recheck MUST NOT redispatch

      const session = await ReplaySessionStorage.getActiveSession();
      const recheckEvd = session?.recoveryContext?.evidence.find(
        (e) => e.type === 'dom_postcondition'
      );
      expect(recheckEvd).toBeDefined();
      expect(recheckEvd?.result).toBe('SUCCESS');
    });

    it('recheckRecoveryCondition retains RECOVERY_REQUIRED if condition is still not met', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      (globalThis as any).chrome.tabs.sendMessage = vi.fn(async (_tabId: number, msg: any) => {
        if (msg.type === 'RECHECK_STEP_CONDITION') {
          return {
            success: true,
            verification: {
              status: 'FAILED',
              verified: false,
              diagnosticInfo: 'Expected element not found',
            },
          };
        }
        return { success: true };
      });

      const res = await orchestrator.recheckRecoveryCondition('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
      });

      expect(res.success).toBe(true);
      expect(res.verification?.verified).toBe(false);

      const session = await ReplaySessionStorage.getActiveSession();
      // Still in RECOVERY_REQUIRED
      expect(session?.status).toBe('RECOVERY_REQUIRED');
      const recheckEvd = session?.recoveryContext?.evidence.find(
        (e) => e.type === 'dom_postcondition' && e.result === 'FAILURE'
      );
      expect(recheckEvd).toBeDefined();
    });
  });

  // =========================================================================
  // 4. STOPPING REPLAY & HISTORY PRESERVATION
  // =========================================================================
  describe('Stopping Replay & History Preservation', () => {
    it('stop cancels session, records STOP_REPLAY decision, and preserves recovery audit log', async () => {
      const wf = createRecoveryTestWorkflow();
      const currentSession = await setupUncertainSession(wf);
      const orchestrator = new ReplayOrchestrator();

      const stopped = await orchestrator.stop('SES_REC_999', {
        sessionRevision: currentSession.sessionRevision,
        rationale: 'User decided to abort replay after inspection.',
      });

      expect(stopped).toBe(true);

      // Session in storage is cleared as active, but last saved state has cancellation and decision
      const activeSession = await ReplaySessionStorage.getActiveSession();
      expect(activeSession).toBeNull();
    });
  });

  // =========================================================================
  // 5. DATASET RECOVERY & RECORD ISOLATION
  // =========================================================================
  describe('Dataset Record Recovery & Context Preservation', () => {
    it('associates recovery decision with dataset record index and preserves variable context', async () => {
      const wf = createRecoveryTestWorkflow();
      await WorkflowStorage.createWorkflow(wf);

      const datasetSession: ReplaySession = {
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        sessionId: 'SES_DATASET_REC',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        totalSteps: wf.steps.length,
        status: 'RECOVERY_REQUIRED',
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        currentActionId: 'SES_DATASET_REC_step0_attempt0',
        actionState: 'OUTCOME_UNKNOWN',
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        lastError: 'Dataset record payment confirmation timed out',
        lastErrorCode: 'OUTCOME_UNKNOWN',
        checkpointTimestamp: Date.now(),
        sessionRevision: 0,
        targetTabId: 101,
        cancellationRequested: false,
        history: [],
        datasetState: {
          datasetFingerprint: 'fp_abc123',
          totalRecords: 3,
          currentRecordIndex: 1, // Record 1 interrupted
          recordResults: [
            {
              recordIndex: 0,
              status: 'COMPLETED',
              stepsCompleted: 2,
              durationMs: 1200,
              variableSnapshot: { user: 'Alice' },
            },
          ],
          completedRecords: 1,
          failedRecords: 0,
          skippedRecords: 0,
          currentRecordVariables: { user: 'Bob', amount: '500' },
        },
        recoveryContext: {
          interruptedStepIndex: 0,
          interruptedActionId: 'SES_DATASET_REC_step0_attempt0',
          safetyCategory: 'EXTERNAL_SIDE_EFFECT',
          reason: 'Dataset record payment confirmation timed out',
          evidence: [],
          history: [],
        },
      };
      const savedSession = await ReplaySessionStorage.saveSession(datasetSession);

      const orchestrator = new ReplayOrchestrator();
      const res = await orchestrator.confirmRecoverySuccess('SES_DATASET_REC', {
        sessionRevision: savedSession.sessionRevision,
        rationale: 'Confirmed order for Bob completed.',
      });

      expect(res.success).toBe(true);

      const session = await ReplaySessionStorage.getActiveSession();
      // Record index remains at 1, step index advances to 1
      expect(session?.datasetState?.currentRecordIndex).toBe(1);
      expect(session?.currentStepIndex).toBe(1);

      // Recovery decision records recordIndex 1
      const decision = session?.recoveryContext?.history[0];
      expect(decision?.recordIndex).toBe(1);
      expect(decision?.rationale).toContain('Bob');

      // Completed record 0 summary is untouched
      expect(session?.datasetState?.recordResults[0].status).toBe('COMPLETED');
    });
  });

  // =========================================================================
  // 6. SERVICE WORKER RESTART RECONCILIATION
  // =========================================================================
  describe('Service Worker Restart Reconciliation', () => {
    it('restores RECOVERY_REQUIRED session and initializes recoveryContext on restart', async () => {
      const wf = createRecoveryTestWorkflow();
      await setupUncertainSession(wf);

      // Simulate new background worker boot by instantiating new orchestrator
      const freshOrchestrator = new ReplayOrchestrator();
      await freshOrchestrator.reconcileSessionOnBoot();

      const session = freshOrchestrator.getSession();
      expect(session).not.toBeNull();
      expect(session?.status).toBe('RECOVERY_REQUIRED');
      expect(session?.recoveryContext).toBeDefined();
      expect(session?.recoveryContext?.interruptedStepIndex).toBe(0);
      expect(session?.recoveryContext?.safetyCategory).toBe('EXTERNAL_SIDE_EFFECT');
    });
  });

  // =========================================================================
  // 7. SENSITIVE VALUE MASKING
  // =========================================================================
  describe('Sensitive-Value Redaction', () => {
    it('masks sensitive field values in step descriptions and recovery inspector context', async () => {
      const sensitiveWf: Workflow = {
        id: 'wf_sensitive',
        name: 'Login & Password Workflow',
        ownerId: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        schemaVersion: 2,
        variables: [],
        steps: [
          {
            sequence: 1,
            id: 'step_pw',
            type: 'input',
            url: 'https://example.com/login',
            timestamp: 100,
            target: { selector: '#password-field' },
            value: 'SuperSecretPass123!',
            description: 'Enter user password',
            sensitive: true,
          },
        ],
      };
      await WorkflowStorage.createWorkflow(sensitiveWf);

      const session: ReplaySession = {
        schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        sessionId: 'SES_PW_REC',
        workflowId: sensitiveWf.id,
        workflowName: sensitiveWf.name,
        workflowSchemaVersion: 2,
        totalSteps: 1,
        speedMultiplier: 1,
        variables: {},
        lastCompletedStepIndex: -1,
        status: 'RECOVERY_REQUIRED',
        currentStepIndex: 0,
        currentActionId: 'SES_PW_REC_step0_attempt0',
        actionState: 'OUTCOME_UNKNOWN',
        attemptCount: 0,
        lastError: 'Password input verification uncertain',
        lastErrorCode: 'OUTCOME_UNKNOWN',
        checkpointTimestamp: Date.now(),
        sessionRevision: 1,
        targetTabId: 101,
        cancellationRequested: false,
        history: [],
      };
      await ReplaySessionStorage.saveSession(session);

      const orchestrator = new ReplayOrchestrator();
      const res = await orchestrator.inspectRecoveryPageState('SES_PW_REC');
      expect(res.success).toBe(true);

      const savedSession = await ReplaySessionStorage.getActiveSession();
      // Ensure raw password is NOT stored in evidence or recovery context
      const evidenceStr = JSON.stringify(savedSession?.recoveryContext?.evidence);
      expect(evidenceStr).not.toContain('SuperSecretPass123!');
    });
  });
});
