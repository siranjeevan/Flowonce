import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ReplaySessionStorage,
  validateReplaySession,
  sanitizeDiagnosticText,
} from '../src/replay/session/ReplaySessionStorage';
import type { ReplaySession } from '../src/replay/session/session-types';
import { ReplayOrchestrator } from '../src/replay/ReplayOrchestrator';
import { WorkflowStorage } from '../src/workflow/storage/WorkflowStorage';
import { STORAGE_KEYS, CURRENT_SESSION_SCHEMA_VERSION } from '../src/workflow/storage/storage-keys';
import type { Workflow } from '../src/shared/types/workflow';

describe('Phase 5: Persistent Replay Session Management and Safe Recovery', () => {
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    mockStorage = {};

    // Mock chrome.storage.local
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
        update: vi.fn(async (_tabId: number, _info: any) => ({})),
        sendMessage: vi.fn(async (_tabId: number, message: any) => {
          if (message.type === 'EXECUTE_STEP') return { success: true };
          if (message.type === 'CHECK_ACTION_EXECUTED') return { success: true, executed: true };
          return { success: true };
        }),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({})),
        lastError: null,
      },
    };
  });

  const createSampleWorkflow = (id = 'wf_sample'): Workflow => ({
    id,
    name: 'Sample Checkout Automation',
    description: 'Automates checkout',
    ownerId: 'local_user',
    version: 1,
    schemaVersion: 2,
    steps: [
      {
        id: 'step_1',
        type: 'click',
        timestamp: Date.now(),
        url: 'https://example.com',
        sequence: 1,
        target: { id: 'btn-1', text: 'Step 1' },
      },
      {
        id: 'step_2',
        type: 'input',
        timestamp: Date.now(),
        url: 'https://example.com',
        sequence: 2,
        value: 'Test Value',
        target: { id: 'input-2' },
      },
      {
        id: 'step_3',
        type: 'click',
        timestamp: Date.now(),
        url: 'https://example.com',
        sequence: 3,
        target: { id: 'btn-submit', text: 'Submit' },
      },
    ],
    variables: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // =========================================================================
  // UNIT TESTS
  // =========================================================================
  describe('Unit Tests: Schema Validation & Storage Primitives', () => {
    it('validates a valid ReplaySession correctly', () => {
      const session: ReplaySession = {
        sessionId: 'SES_123',
        workflowId: 'wf_1',
        workflowName: 'Test WF',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        totalSteps: 3,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'RUNNING',
        actionState: 'DISPATCHING',
        currentActionId: 'SES_123_step0_attempt0',
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };

      const result = validateReplaySession(session);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('rejects invalid session properties and produces structured errors', () => {
      const invalid = {
        sessionId: '',
        workflowId: '',
        totalSteps: -1,
        currentStepIndex: -5,
        status: 'INVALID_STATUS',
        actionState: 'UNKNOWN_STATE',
      };

      const result = validateReplaySession(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    });

    it('persists and retrieves session with automatic revision increments', async () => {
      const session: ReplaySession = {
        sessionId: 'SES_REV_TEST',
        workflowId: 'wf_1',
        workflowName: 'Test WF',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: 2,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'STARTING',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };

      const saved1 = await ReplaySessionStorage.saveSession(session);
      expect(saved1.sessionRevision).toBe(1);

      const loaded = await ReplaySessionStorage.getActiveSession();
      expect(loaded).toBeTruthy();
      expect(loaded?.sessionId).toBe('SES_REV_TEST');
      expect(loaded?.sessionRevision).toBe(1);

      const saved2 = await ReplaySessionStorage.saveSession(saved1);
      expect(saved2.sessionRevision).toBe(2);
    });

    it('redacts sensitive information in diagnostics', () => {
      const sensitive = 'User password: "secretPassword123" and Authorization: Bearer abcXYZ123456';
      const sanitized = sanitizeDiagnosticText(sensitive);
      expect(sanitized).not.toContain('secretPassword123');
      expect(sanitized).not.toContain('abcXYZ123456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('caps diagnostic event log to prevent memory leaks', () => {
      const session: ReplaySession = {
        sessionId: 'SES_EVENT_CAP',
        workflowId: 'wf_1',
        workflowName: 'Test WF',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: 1,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'RUNNING',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };

      for (let i = 0; i < 45; i++) {
        ReplaySessionStorage.appendEvent(session, 'STEP_PREPARED', `Step ${i}`);
      }

      expect(session.eventLog.length).toBe(30);
      expect(session.eventLog[session.eventLog.length - 1].details).toBe('Step 44');
    });

    it('archives cleared sessions into historical storage capped at 10', async () => {
      for (let i = 1; i <= 12; i++) {
        const session: ReplaySession = {
          sessionId: `SES_HIST_${i}`,
          workflowId: 'wf_1',
          workflowName: `Test WF ${i}`,
          workflowSchemaVersion: 2,
          sessionSchemaVersion: 1,
          totalSteps: 1,
          targetTabId: 101,
          currentStepIndex: 1,
          lastCompletedStepIndex: 1,
          status: 'COMPLETED',
          actionState: 'NOT_STARTED',
          currentActionId: null,
          attemptCount: 0,
          speedMultiplier: 1,
          variables: {},
          navigationPending: false,
          cancellationRequested: false,
          lastError: null,
          sessionRevision: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          eventLog: [],
        };

        await ReplaySessionStorage.saveSession(session);
        await ReplaySessionStorage.clearActiveSession('COMPLETED');
      }

      const active = await ReplaySessionStorage.getActiveSession();
      expect(active).toBeNull();

      const histData = await chrome.storage.local.get([STORAGE_KEYS.SESSION_HISTORY]);
      const history = histData[STORAGE_KEYS.SESSION_HISTORY];
      expect(history.length).toBe(10);
      expect(history[0].sessionId).toBe('SES_HIST_12');
    });

    it('safely handles corrupted session records in storage without crashing', async () => {
      mockStorage[STORAGE_KEYS.ACTIVE_SESSION] = { corrupted: true, garbage: 12345 };

      const active = await ReplaySessionStorage.getActiveSession();
      expect(active).toBeNull();
    });
  });

  // =========================================================================
  // INTEGRATION TESTS
  // =========================================================================
  describe('Integration Tests: Replay Lifecycle & Service Worker Recovery', () => {
    let orchestrator: ReplayOrchestrator;

    beforeEach(async () => {
      orchestrator = new ReplayOrchestrator();
      const wf = createSampleWorkflow();
      await WorkflowStorage.createWorkflow(wf);
    });

    it('1. Normal workflow execution: transitions through checkpoints and completes', async () => {
      const wf = createSampleWorkflow();
      const startResult = await orchestrator.start(wf, {}, 5, 101);
      expect(startResult.success).toBe(true);

      const session = orchestrator.getSession();
      expect(session).toBeTruthy();
      expect(session?.workflowId).toBe(wf.id);

      // Verify active session was persisted
      const persisted = await ReplaySessionStorage.getActiveSession();
      expect(persisted).toBeTruthy();
      expect(persisted?.sessionId).toBe(startResult.sessionId);
    });

    it('2. Pause and resume: halts execution and resumes cleanly from same step', async () => {
      const wf = createSampleWorkflow();
      await orchestrator.start(wf, {}, 5, 101);

      // Pause
      const paused = await orchestrator.pause();
      expect(paused).toBe(true);

      let session = await ReplaySessionStorage.getActiveSession();
      expect(session?.status).toBe('PAUSED');

      // Resume
      const resumed = await orchestrator.resume();
      expect(resumed).toBe(true);

      session = await ReplaySessionStorage.getActiveSession();
      expect(session?.status).not.toBe('PAUSED');
    });

    it('3. Stop during replay: marks CANCELLED and clears active session', async () => {
      const wf = createSampleWorkflow();
      await orchestrator.start(wf, {}, 5, 101);

      const stopped = await orchestrator.stop();
      expect(stopped).toBe(true);

      const active = await ReplaySessionStorage.getActiveSession();
      expect(active).toBeNull();
    });

    it('4. Service worker restart before an action: resumes safely from step checkpoint', async () => {
      const wf = createSampleWorkflow();
      // Setup persisted session in storage simulating SW restart while WAITING
      const persistedSession: ReplaySession = {
        sessionId: 'SES_SW_BOOT_1',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: wf.steps.length,
        targetTabId: 101,
        currentStepIndex: 1,
        lastCompletedStepIndex: 0,
        status: 'WAITING',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 2,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 4,
        startedAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000,
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(persistedSession);

      // Reconcile on boot
      const freshOrchestrator = new ReplayOrchestrator();
      await freshOrchestrator.reconcileSessionOnBoot();

      const restoredSession = freshOrchestrator.getSession();
      expect(restoredSession).toBeTruthy();
      expect(restoredSession?.currentStepIndex).toBe(1);
    });

    it('5. Service worker restart after dispatch: advances if confirmed, marks RECOVERY_REQUIRED if uncertain', async () => {
      const wf = createSampleWorkflow();

      // Case A: Content script confirms action was executed
      const sessionA: ReplaySession = {
        sessionId: 'SES_SW_DISPATCH_CONFIRMED',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: wf.steps.length,
        targetTabId: 101,
        currentStepIndex: 1,
        lastCompletedStepIndex: 0,
        status: 'RUNNING',
        actionState: 'DISPATCHING',
        currentActionId: 'SES_SW_DISPATCH_CONFIRMED_step1_attempt0',
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 5,
        startedAt: Date.now() - 4000,
        updatedAt: Date.now() - 200,
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(sessionA);

      const orchA = new ReplayOrchestrator();
      await orchA.reconcileSessionOnBoot();

      const sessionAfterA = await ReplaySessionStorage.getActiveSession();
      // Should have advanced step index to 2!
      expect(sessionAfterA?.lastCompletedStepIndex).toBe(1);
      expect(sessionAfterA?.currentStepIndex).toBe(2);

      await orchA.stop();

      // Case B: Content script cannot confirm action execution (uncertain outcome)
      chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));

      const sessionB: ReplaySession = {
        sessionId: 'SES_SW_DISPATCH_UNCERTAIN',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: wf.steps.length,
        targetTabId: 101,
        currentStepIndex: 2,
        lastCompletedStepIndex: 1,
        status: 'RUNNING',
        actionState: 'DISPATCHING',
        currentActionId: 'SES_SW_DISPATCH_UNCERTAIN_step2_attempt0',
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 8,
        startedAt: Date.now() - 6000,
        updatedAt: Date.now() - 500,
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(sessionB);

      const orchB = new ReplayOrchestrator();
      await orchB.reconcileSessionOnBoot();

      const sessionAfterB = await ReplaySessionStorage.getActiveSession();
      // Must NOT blindly re-execute! Must mark RECOVERY_REQUIRED
      expect(sessionAfterB?.status).toBe('RECOVERY_REQUIRED');
      expect(sessionAfterB?.actionState).toBe('OUTCOME_UNKNOWN');
    });

    it('6. Tab closure during replay: marks session as FAILED without unhandled crash', async () => {
      const wf = createSampleWorkflow();
      const sessionWithDeadTab: ReplaySession = {
        sessionId: 'SES_DEAD_TAB',
        workflowId: wf.id,
        workflowName: wf.name,
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: wf.steps.length,
        targetTabId: 999, // mocked to throw Tab not found
        currentStepIndex: 1,
        lastCompletedStepIndex: 0,
        status: 'RUNNING',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 3,
        startedAt: Date.now() - 2000,
        updatedAt: Date.now() - 100,
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(sessionWithDeadTab);

      const freshOrchestrator = new ReplayOrchestrator();
      await freshOrchestrator.reconcileSessionOnBoot();

      const active = await ReplaySessionStorage.getActiveSession();
      expect(active?.status).toBe('FAILED');
      expect(active?.lastErrorCode).toBe('TAB_CLOSED');
    });

    it('7. Duplicate PLAY command prevention: rejects starting a second session while active', async () => {
      const wf = createSampleWorkflow();
      const first = await orchestrator.start(wf, {}, 1, 101);
      expect(first.success).toBe(true);

      // Attempt to start a second workflow concurrently
      const second = await orchestrator.start(wf, {}, 1, 101);
      expect(second.success).toBe(false);
      expect(second.error).toContain('is already active');
    });

    it('8. Stale session command rejection: commands with mismatched sessionId are ignored', async () => {
      const wf = createSampleWorkflow();
      await orchestrator.start(wf, {}, 1, 101);

      // Stop command with stale/wrong session ID
      const stopped = await orchestrator.stop('SES_OBSOLETE_ID_999');
      expect(stopped).toBe(false);

      // Active session should remain untouched
      const active = await ReplaySessionStorage.getActiveSession();
      expect(active?.status).not.toBe('CANCELLED');
    });

    it('9. Concurrent session updates: serialized enqueue prevents lost updates', async () => {
      const session: ReplaySession = {
        sessionId: 'SES_CONCURRENT',
        workflowId: 'wf_1',
        workflowName: 'Test WF',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: 5,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'RUNNING',
        actionState: 'NOT_STARTED',
        currentActionId: null,
        attemptCount: 0,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: null,
        sessionRevision: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(session);

      // Fire 5 concurrent updates simultaneously
      await Promise.all([
        ReplaySessionStorage.updateSession((s) => ({ ...s, currentStepIndex: s.currentStepIndex + 1 })),
        ReplaySessionStorage.updateSession((s) => ({ ...s, currentStepIndex: s.currentStepIndex + 1 })),
        ReplaySessionStorage.updateSession((s) => ({ ...s, currentStepIndex: s.currentStepIndex + 1 })),
        ReplaySessionStorage.updateSession((s) => ({ ...s, currentStepIndex: s.currentStepIndex + 1 })),
        ReplaySessionStorage.updateSession((s) => ({ ...s, currentStepIndex: s.currentStepIndex + 1 })),
      ]);

      const finalSession = await ReplaySessionStorage.getActiveSession();
      expect(finalSession?.currentStepIndex).toBe(5);
      expect(finalSession?.sessionRevision).toBe(6);
    });
  });
});
