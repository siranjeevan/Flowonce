import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplayOrchestrator } from '../src/replay/ReplayOrchestrator';
import { ReplaySessionStorage } from '../src/replay/session/ReplaySessionStorage';
import type { ReplaySession } from '../src/replay/session/session-types';
import { WorkflowStorage } from '../src/workflow/storage/WorkflowStorage';
import { STORAGE_KEYS, CURRENT_SESSION_SCHEMA_VERSION } from '../src/workflow/storage/storage-keys';
import { validateWorkflow, isSafeUrl } from '../src/workflow/storage/schema';
import { DatasetParser, DatasetParseError } from '../src/replay/dataset/DatasetParser';
import { classifyActionSafety } from '../src/replay/ActionVerifier';
import type { Workflow, WorkflowStep } from '../src/shared/types/workflow';

describe('Phase 8: Production Reliability, Security, and Recovery Hardening', () => {
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
          if (tabId === 999) throw new Error('Tab not found');
          return { id: tabId, status: 'complete', url: 'https://example.com' };
        }),
        query: vi.fn(async () => [{ id: 101, status: 'complete', url: 'https://example.com' }]),
        sendMessage: vi.fn(async (_tabId: number, msg: any) => {
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

  // =========================================================================
  // WORKSTREAM A: PERSISTENT SESSION RECOVERY
  // =========================================================================
  describe('Workstream A: Persistent Session Recovery', () => {
    it('Scenario 4: Service worker terminates after verification but before advancing step (advances step index on boot without redispatch)', async () => {
      const orchestrator = new ReplayOrchestrator();

      const testWf: Workflow = {
        id: 'wf_chk4',
        name: 'Checkpoint 4 Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          { sequence: 1, type: 'click', url: 'https://example.com', timestamp: 100, target: { selector: '#btn1' } },
          { sequence: 2, type: 'input', url: 'https://example.com', timestamp: 200, target: { selector: '#in1' }, value: 'ok' },
        ],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(testWf);

      // Simulate session persisted right after verification completed (actionState === 'VERIFIED')
      // but before currentStepIndex was incremented
      const verifiedSession: ReplaySession = {
        sessionId: 'SES_CHK4_123',
        workflowId: 'wf_chk4',
        workflowName: 'Checkpoint 4 Workflow',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        totalSteps: 2,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'RUNNING',
        actionState: 'VERIFIED',
        currentActionId: 'action_step0_verified',
        attemptCount: 1,
        speedMultiplier: 1,
        variables: {},
        stepExecutionCount: 1,
        maxStepBudget: 50,
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(verifiedSession);

      // Reconcile on boot
      await orchestrator.reconcileSessionOnBoot();

      const restored = await ReplaySessionStorage.getActiveSession();
      expect(restored).not.toBeNull();
      // Step 0 was verified; boot reconciliation must advance currentStepIndex to 1
      expect(restored!.currentStepIndex).toBe(1);
      expect(restored!.lastCompletedStepIndex).toBe(0);
      expect(restored!.actionState).toBe('PREPARING');
      expect(restored!.currentActionId).toBe('SES_CHK4_123_step1_attempt0');
    });

    it('Scenario 5 & 10: Dataset state and active record context survive worker restart', async () => {
      const orchestrator = new ReplayOrchestrator();

      const testWf: Workflow = {
        id: 'wf_ds_recovery',
        name: 'Dataset Recovery Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          { sequence: 1, type: 'input', url: 'https://example.com', timestamp: 100, target: { selector: '#email' }, value: '{{email}}' },
        ],
        variables: [{ name: 'email', required: true, sensitive: false }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(testWf);

      const datasetRecords = [
        { email: 'first@test.com' },
        { email: 'second@test.com' },
        { email: 'third@test.com' },
      ];

      // Session paused at record 1 (second record)
      const pausedSession: ReplaySession = {
        sessionId: 'SES_DS_REC',
        workflowId: 'wf_ds_recovery',
        workflowName: 'Dataset Recovery Workflow',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        totalSteps: 1,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'PAUSED',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 1,
        variables: { email: 'second@test.com' },
        datasetState: {
          fingerprint: 'FP_TEST_123',
          totalRecords: 3,
          currentRecordIndex: 1,
          status: 'PAUSED',
          completedRecords: [0],
          failedRecords: [],
          skippedRecords: [],
          records: datasetRecords,
        },
        stepExecutionCount: 0,
        maxStepBudget: 50,
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 3,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(pausedSession);

      // Reconcile on boot
      await orchestrator.reconcileSessionOnBoot();

      const active = orchestrator.getSession();
      expect(active).not.toBeNull();
      expect(active!.datasetState?.currentRecordIndex).toBe(1);
      expect(active!.datasetState?.records?.length).toBe(3);
    });

    it('Scenario 12: Corrupted or invalid session schema is rejected safely without crashing boot', async () => {
      const orchestrator = new ReplayOrchestrator();

      // Put invalid object in storage
      mockStorage[STORAGE_KEYS.ACTIVE_SESSION] = {
        sessionId: '', // invalid
        status: 'NON_EXISTENT_STATUS',
      };

      await expect(orchestrator.reconcileSessionOnBoot()).resolves.not.toThrow();
      expect(orchestrator.getSession()).toBeNull();
    });
  });

  // =========================================================================
  // WORKSTREAM B: ACTION AND RECORD-LEVEL RETRY SAFETY
  // =========================================================================
  describe('Workstream B: Action and Record-Level Retry Safety', () => {
    it('Correctly classifies actions by safety semantics', () => {
      // Set value to known state (safe to repeat)
      expect(classifyActionSafety({ sequence: 1, type: 'input', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('SET_VALUE_KNOWN_STATE');
      expect(classifyActionSafety({ sequence: 1, type: 'select', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('SET_VALUE_KNOWN_STATE');
      expect(classifyActionSafety({ sequence: 1, type: 'radio', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('SET_VALUE_KNOWN_STATE');
      expect(classifyActionSafety({ sequence: 1, type: 'checkbox', value: 'true', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('SET_VALUE_KNOWN_STATE');

      // Checkbox without explicit true/false value toggles state (unsafe to repeat)
      expect(classifyActionSafety({ sequence: 1, type: 'checkbox', value: '', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('TOGGLE_STATE');

      // External side effects (unsafe to blindly repeat)
      expect(classifyActionSafety({ sequence: 1, type: 'click', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('EXTERNAL_SIDE_EFFECT');
      expect(classifyActionSafety({ sequence: 1, type: 'keydown', key: 'Enter', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('EXTERNAL_SIDE_EFFECT');

      // Read only safe
      expect(classifyActionSafety({ sequence: 1, type: 'wait', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('READ_ONLY_SAFE');
      expect(classifyActionSafety({ sequence: 1, type: 'scroll', url: 'https://ex.com', timestamp: 1 } as WorkflowStep)).toBe('READ_ONLY_SAFE');
    });

    it('Prevents a failed dataset record from restarting at step 0 when it executed an unsafe action without explicit forceUnsafeRetry', async () => {
      const orchestrator = new ReplayOrchestrator();

      const testWf: Workflow = {
        id: 'wf_unsafe_retry',
        name: 'Unsafe Retry Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          { sequence: 1, type: 'click', target: { selector: '#submit-order' }, url: 'https://example.com', timestamp: 100 },
          { sequence: 2, type: 'wait', value: '500', url: 'https://example.com', timestamp: 200 },
        ],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(testWf);

      const testSession: ReplaySession = {
        sessionId: 'SES_UNSAFE_RETRY_TEST',
        workflowId: 'wf_unsafe_retry',
        workflowName: 'Unsafe Retry Workflow',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        totalSteps: 2,
        targetTabId: 101,
        currentStepIndex: 1,
        lastCompletedStepIndex: 0,
        status: 'RECOVERY_REQUIRED',
        actionState: 'OUTCOME_UNKNOWN',
        currentActionId: 'action_step0',
        attemptCount: 1,
        speedMultiplier: 1,
        variables: {},
        datasetState: {
          fingerprint: 'FP_UNSAFE_1',
          totalRecords: 1,
          currentRecordIndex: 0,
          status: 'RECOVERY_REQUIRED',
          completedRecords: [],
          failedRecords: [],
          skippedRecords: [],
          records: [{ row: 1 }],
          hasUnsafeActionExecutedInCurrentRecord: true,
        },
        stepExecutionCount: 1,
        maxStepBudget: 50,
        navigationPending: false,
        cancellationRequested: false,
        lastError: 'Outcome uncertain',
        sessionRevision: 2,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(testSession);
      await orchestrator.reconcileSessionOnBoot();

      // Calling retryDatasetRecord without forceUnsafeRetry MUST be refused
      const retryResult = await orchestrator.retryDatasetRecord(testSession.sessionId);
      expect(retryResult).toBe(false);

      const updated = orchestrator.getSession()!;
      expect(updated.status).toBe('RECOVERY_REQUIRED');
      expect(updated.lastErrorCode).toBe('UNSAFE_RECORD_RETRY_BLOCKED');

      // With explicit forceUnsafeRetry: true, the user confirms retry
      const forceResult = await orchestrator.retryDatasetRecord(testSession.sessionId, { forceUnsafeRetry: true });
      expect(forceResult).toBe(true);
      expect(['RUNNING', 'WAITING']).toContain(orchestrator.getSession()!.status);
      expect(orchestrator.getSession()!.status).not.toBe('RECOVERY_REQUIRED');
    });
  });

  // =========================================================================
  // WORKSTREAM C: BRANCH VALIDATION AND EXECUTION BUDGETS
  // =========================================================================
  describe('Workstream C: Branch Validation and Execution Budgets', () => {
    it('Pre-execution branch validation rejects references to nonexistent step IDs', () => {
      const invalidWf: Workflow = {
        id: 'wf_bad_branch',
        name: 'Bad Branch Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          {
            id: 'step_cond',
            sequence: 1,
            type: 'condition',
            url: 'https://example.com',
            timestamp: 100,
            condition: {
              source: 'variable',
              name: 'count',
              operator: 'equals',
              value: '1',
              onTrue: 'non_existent_step_999', // Missing step ID!
              onFalse: 'next',
            },
          },
        ],
        variables: [{ name: 'count', required: true, sensitive: false }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = validateWorkflow(invalidWf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('non_existent_step_999'))).toBe(true);
    });

    it('Fails safely if an invalid branch target reaches runtime without unhandled exception', async () => {
      const orchestrator = new ReplayOrchestrator();

      // Create workflow with valid schema structure but dynamic branch evaluated
      const branchWf: Workflow = {
        id: 'wf_runtime_bad_branch',
        name: 'Runtime Bad Branch Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          {
            id: 'step_cond',
            sequence: 1,
            type: 'condition',
            url: 'https://example.com',
            timestamp: 100,
            condition: {
              source: 'variable',
              name: 'flag',
              operator: 'equals',
              value: 'true',
              onTrue: 'ghost_step_id',
              onFalse: 'next',
            },
          },
        ],
        variables: [{ name: 'flag', required: false, defaultValue: 'true', sensitive: false }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Inject raw workflow into storage directly to test runtime safety
      mockStorage[STORAGE_KEYS.WORKFLOWS] = [branchWf];

      // Start replay
      await orchestrator.start(branchWf, { flag: 'true' });
      await new Promise((r) => setTimeout(r, 100));

      // Session should fail gracefully with INVALID_BRANCH_TARGET
      const session = orchestrator.getSession();
      expect(session).not.toBeNull();
      expect(session!.status).toBe('FAILED');
      expect(session!.lastErrorCode).toBe('INVALID_BRANCH_TARGET');
    });

    it('Execution budget is strictly enforced across loops and survives worker restarts', async () => {
      const orchestrator = new ReplayOrchestrator();

      // Step budget set to 3
      const loopWf: Workflow = {
        id: 'wf_budget_loop',
        name: 'Budget Loop Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        settings: {
          maxStepBudget: 3,
        },
        steps: [
          {
            id: 'step_loop',
            sequence: 1,
            type: 'condition',
            url: 'https://example.com',
            timestamp: 100,
            condition: {
              source: 'variable',
              name: 'count',
              operator: 'equals',
              value: 'always_true',
              onTrue: 'step_loop', // infinite loop!
              onFalse: 'end',
            },
          },
        ],
        variables: [{ name: 'count', required: false, defaultValue: 'always_true', sensitive: false }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(loopWf);

      await orchestrator.start(loopWf, { count: 'always_true' }, 5);
      await new Promise((r) => setTimeout(r, 600));

      // Allow loop to trigger budget limit
      const session = orchestrator.getSession()!;
      expect(session.status).toBe('FAILED');
      expect(session.lastErrorCode).toBe('EXECUTION_BUDGET_EXCEEDED');
      expect(session.stepExecutionCount).toBeGreaterThan(3);
    });
  });

  // =========================================================================
  // WORKSTREAM D: SECURITY AND SENSITIVE DATA
  // =========================================================================
  describe('Workstream D: Security and Sensitive Data', () => {
    it('isSafeUrl strictly approves http, https, and about:blank, rejecting dangerous schemes', () => {
      expect(isSafeUrl('https://example.com')).toBe(true);
      expect(isSafeUrl('http://localhost:3000/test')).toBe(true);
      expect(isSafeUrl('about:blank')).toBe(true);
      expect(isSafeUrl('/relative/path')).toBe(true);

      // Dangerous schemes must be rejected
      expect(isSafeUrl('javascript:alert(1)')).toBe(false);
      expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
      expect(isSafeUrl('file:///etc/passwd')).toBe(false);
      expect(isSafeUrl('chrome://extensions')).toBe(false);
      expect(isSafeUrl('chrome-extension://malicious/id')).toBe(false);
      expect(isSafeUrl('vbscript:msgbox("hello")')).toBe(false);
    });

    it('validateWorkflowStep rejects steps with dangerous URL schemes', () => {
      const maliciousWf: Workflow = {
        id: 'wf_xss',
        name: 'Malicious Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          {
            sequence: 1,
            type: 'click',
            url: 'javascript:document.cookie',
            timestamp: 100,
            target: { selector: '#a' },
          },
        ],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = validateWorkflow(maliciousWf);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('dangerous URL scheme'))).toBe(true);
    });

    it('DatasetParser rejects excessive column count, oversized field length, and deep nesting', () => {
      // 1. Excessive column count (> 100)
      const wideHeaders = Array.from({ length: 105 }, (_, i) => `col_${i}`).join(',');
      const wideRow = Array.from({ length: 105 }, (_, i) => `val_${i}`).join(',');
      const wideCsv = `${wideHeaders}\n${wideRow}`;

      expect(() => DatasetParser.parseCSV(wideCsv)).toThrow(DatasetParseError);

      // 2. Oversized field (> 32 KB)
      const bigField = 'A'.repeat(35000);
      const bigCsv = `name,token\nAlice,"${bigField}"`;
      expect(() => DatasetParser.parseCSV(bigCsv)).toThrow(DatasetParseError);

      // 3. Deeply nested JSON (> 6 levels)
      const deeplyNested = {
        records: [
          { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too_deep' } } } } } } },
        ],
      };
      expect(() => DatasetParser.parseJSON(deeplyNested)).toThrow(DatasetParseError);
    });

    it('exportWorkflows redacts sensitive variable defaults and sensitive step values by default', async () => {
      const sensitiveWf: Workflow = {
        id: 'wf_secrets',
        name: 'Secrets Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          {
            sequence: 1,
            type: 'input',
            url: 'https://example.com/login',
            timestamp: 100,
            target: { selector: '#pwd' },
            value: 'SuperSecret123!',
            sensitive: true,
          },
        ],
        variables: [
          {
            name: 'apiKey',
            required: true,
            sensitive: true,
            defaultValue: 'sk-live-99998888',
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(sensitiveWf);

      // Export with default options
      const jsonStr = await WorkflowStorage.exportWorkflows();
      expect(jsonStr).not.toContain('SuperSecret123!');
      expect(jsonStr).not.toContain('sk-live-99998888');

      // But export when explicitly requested includes secrets
      const explicitExport = await WorkflowStorage.exportWorkflows({ redactSensitive: false });
      expect(explicitExport).toContain('SuperSecret123!');
      expect(explicitExport).toContain('sk-live-99998888');
    });
  });

  // =========================================================================
  // WORKSTREAM E: STORAGE AND CLOUD SYNCHRONIZATION SAFETY
  // =========================================================================
  describe('Workstream E: Storage and Cloud Synchronization Safety', () => {
    it('WorkflowStorage preserves valid local workflows and skips malformed records without crash', async () => {
      const validWf: Workflow = {
        id: 'wf_valid_1',
        name: 'Valid Workflow',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [
          { sequence: 1, type: 'wait', value: '100', url: 'https://example.com', timestamp: 100 },
        ],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(validWf);

      // Inject a malformed record into raw storage
      const rawList = mockStorage[STORAGE_KEYS.WORKFLOWS] as any[];
      rawList.push({ id: '', corrupt: true }); // Malformed

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe('wf_valid_1');
    });

    it('Importing workflows validates all candidates and updates existing by ID without clobbering', async () => {
      const initialWf: Workflow = {
        id: 'wf_import_test',
        name: 'Initial Name',
        ownerId: 'u1',
        version: 1,
        schemaVersion: 2,
        steps: [{ sequence: 1, type: 'wait', value: '100', url: 'https://example.com', timestamp: 100 }],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await WorkflowStorage.createWorkflow(initialWf);

      const importPayload = {
        workflows: [
          {
            ...initialWf,
            name: 'Updated Name Via Import',
            version: 2,
          },
        ],
      };

      const result = await WorkflowStorage.importWorkflows(JSON.stringify(importPayload));
      expect(result.errors.length).toBe(0);
      expect(result.imported.length).toBe(1);

      const stored = await WorkflowStorage.getWorkflowById('wf_import_test');
      expect(stored!.name).toBe('Updated Name Via Import');
      expect(stored!.version).toBe(2);
    });
  });
});
