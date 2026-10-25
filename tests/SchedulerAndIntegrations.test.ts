import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScheduleManager } from '../src/automation/scheduler/ScheduleManager';
import { IntegrationExecutor } from '../src/integrations/IntegrationExecutor';
import { ExecutionHistoryManager } from '../src/automation/history/ExecutionHistoryManager';
import { CollaborationManager } from '../src/collaboration/CollaborationManager';
import { STORAGE_KEYS } from '../src/workflow/storage/storage-keys';
import type { WorkflowSchedule } from '../src/automation/scheduler/scheduler-types';
import type { IntegrationConfig } from '../src/integrations/integration-types';
import type { Workflow } from '../src/shared/types/workflow';

// Global mocks for Chrome extension APIs
let mockStorage: Record<string, unknown> = {};
let mockAlarms: Record<string, { periodInMinutes?: number; when?: number }> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
        if (!key) return { ...mockStorage };
        if (typeof key === 'string') return { [key]: mockStorage[key] };
        if (Array.isArray(key)) {
          const res: Record<string, unknown> = {};
          for (const k of key) res[k] = mockStorage[k];
          return res;
        }
        return { ...mockStorage };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
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
  alarms: {
    create: vi.fn(async (name: string, alarmInfo: any) => {
      mockAlarms[name] = alarmInfo;
    }),
    clear: vi.fn(async (name: string) => {
      delete mockAlarms[name];
      return true;
    }),
    get: vi.fn(async (name: string) => {
      return mockAlarms[name] ? { name, ...mockAlarms[name] } : null;
    }),
    getAll: vi.fn(async () => {
      return Object.entries(mockAlarms).map(([name, info]) => ({ name, ...info }));
    }),
  },
  tabs: {
    query: vi.fn(async () => [{ id: 101, url: 'https://example.com' }]),
    create: vi.fn(async () => ({ id: 102 })),
  },
};

(globalThis as any).chrome = chromeMock;

describe('Phase 11: Scheduler, Safe Integrations, Analytics, and Collaboration', () => {
  beforeEach(() => {
    mockStorage = {};
    mockAlarms = {};
    vi.clearAllMocks();
  });

  describe('Scheduled Execution via Chrome Alarms (ScheduleManager)', () => {
    const mockWorkflow: Workflow = {
      id: 'wf_sched_target',
      name: 'Automated Health Check',
      description: 'Navigates and clicks button periodically',
      version: 1,
      createdAt: 1000,
      updatedAt: 1000,
      steps: [
        {
          id: 'step_nav',
          type: 'navigate',
          timestamp: 100,
          url: 'https://example.com/status',
          sequence: 0,
        },
        {
          id: 'step_btn',
          type: 'click',
          timestamp: 200,
          url: 'https://example.com/status',
          sequence: 1,
        },
      ],
    };

    it('creates an interval schedule and registers chrome.alarm', async () => {
      mockStorage[STORAGE_KEYS.WORKFLOWS] = [mockWorkflow];

      const schedule: WorkflowSchedule = {
        id: 'sched_interval_1',
        name: 'Every 30 Minutes Status Check',
        workflowId: 'wf_sched_target',
        workflowName: 'Automated Health Check',
        type: 'interval',
        intervalMinutes: 30,
        enabled: true,
        forceUnsafeAuthorization: true,
        createdAt: 1000,
      };

      await ScheduleManager.saveSchedule(schedule);

      const retrieved = await ScheduleManager.getSchedule('sched_interval_1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('sched_interval_1');
      expect(chromeMock.alarms.create).toHaveBeenCalledWith(
        'FLOWONCE_SCHED_sched_interval_1',
        expect.objectContaining({ periodInMinutes: 30 })
      );
    });

    it('enforces side-effect authorization gate for workflows with state-modifying actions', async () => {
      mockStorage[STORAGE_KEYS.WORKFLOWS] = [mockWorkflow];

      const unconfirmedSchedule: WorkflowSchedule = {
        id: 'sched_unsafe_blocked',
        name: 'Unauthorized Side Effect Schedule',
        workflowId: 'wf_sched_target',
        workflowName: 'Automated Health Check',
        type: 'interval',
        intervalMinutes: 15,
        enabled: true,
        forceUnsafeAuthorization: false, // User has NOT given explicit authorization
        createdAt: 1000,
      };

      await expect(ScheduleManager.saveSchedule(unconfirmedSchedule)).rejects.toThrow(
        /authorization|side-effect/i
      );
    });

    it('clears chrome alarm when schedule is disabled or deleted', async () => {
      mockStorage[STORAGE_KEYS.WORKFLOWS] = [mockWorkflow];

      const schedule: WorkflowSchedule = {
        id: 'sched_to_disable',
        name: 'Disabling Test',
        workflowId: 'wf_sched_target',
        workflowName: 'Target WF',
        type: 'interval',
        intervalMinutes: 60,
        enabled: true,
        forceUnsafeAuthorization: true,
        createdAt: 1000,
      };

      await ScheduleManager.saveSchedule(schedule);
      expect(mockAlarms['FLOWONCE_SCHED_sched_to_disable']).toBeDefined();

      await ScheduleManager.toggleSchedule('sched_to_disable', false);
      expect(chromeMock.alarms.clear).toHaveBeenCalledWith('FLOWONCE_SCHED_sched_to_disable');
      expect(mockAlarms['FLOWONCE_SCHED_sched_to_disable']).toBeUndefined();
    });

    it('restores registered alarms on service worker boot', async () => {
      const storedSchedules: WorkflowSchedule[] = [
        {
          id: 'sched_boot_1',
          name: 'Boot Schedule 1',
          workflowId: 'wf_1',
          workflowName: 'WF 1',
          type: 'interval',
          intervalMinutes: 15,
          enabled: true,
          forceUnsafeAuthorization: true,
          createdAt: 1000,
        },
        {
          id: 'sched_boot_disabled',
          name: 'Boot Schedule Disabled',
          workflowId: 'wf_2',
          workflowName: 'WF 2',
          type: 'interval',
          intervalMinutes: 60,
          enabled: false,
          forceUnsafeAuthorization: true,
          createdAt: 1000,
        },
      ];

      mockStorage[STORAGE_KEYS.SCHEDULES] = storedSchedules;

      await ScheduleManager.initializeSchedulerOnBoot();

      // Only the enabled schedule should have alarm recreated
      expect(chromeMock.alarms.create).toHaveBeenCalledWith(
        'FLOWONCE_SCHED_sched_boot_1',
        expect.objectContaining({ periodInMinutes: 15 })
      );
      expect(chromeMock.alarms.create).not.toHaveBeenCalledWith(
        'FLOWONCE_SCHED_sched_boot_disabled',
        expect.anything()
      );
    });
  });

  describe('Safe API Integrations (IntegrationExecutor)', () => {
    const webhookIntegration: IntegrationConfig = {
      id: 'integ_test_webhook',
      integrationId: 'webhook-dispatcher',
      name: 'Order Notification Webhook',
      endpointUrl: 'https://api.example.com/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      authHeader: 'Bearer test_secret_token_123',
      idempotencyHeaderKey: 'X-FlowOnce-Idempotency-Key',
      timeoutMs: 3000,
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
    };

    it('validates input schema and rejects invalid payload before network call', async () => {
      const invalidPayload = {}; // missing required 'payload'

      const result = await IntegrationExecutor.execute(webhookIntegration, invalidPayload);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/required.*missing/i);
    });

    it('executes network call, attaches idempotency key header, and parses response', async () => {
      const mockFetch = vi.fn(async (url: string, init: any) => {
        // Assert idempotency header is present
        expect(init.headers['X-FlowOnce-Idempotency-Key']).toBeDefined();

        return {
          ok: true,
          status: 200,
          headers: {
            get: (h: string) => (h === 'content-length' ? '50' : null),
          },
          text: async () => JSON.stringify({ status: 'confirmed', transactionId: 'TX_99' }),
        };
      });

      (globalThis as any).fetch = mockFetch;

      const validPayload = { payload: { orderId: 'ORD_101', total: 49.99 } };
      const result = await IntegrationExecutor.execute(webhookIntegration, validPayload);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.data?.status).toBe('confirmed');
      expect(result.idempotencyKey).toBeDefined();
    });

    it('enforces maximum response size limit (512KB) to protect extension memory', async () => {
      const oversizedBody = 'x'.repeat(600 * 1024); // 600KB, exceeds 512KB

      (globalThis as any).fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (h: string) => (h === 'content-length' ? String(600 * 1024) : null),
        },
        text: async () => oversizedBody,
      }));

      const result = await IntegrationExecutor.execute(webhookIntegration, {
        payload: { orderId: 'ORD_101', total: 10.0 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds.*limit/i);
    });

    it('redacts sensitive Authorization tokens in error reports and logs', async () => {
      (globalThis as any).fetch = vi.fn(async () => {
        throw new Error('Network error connecting with Authorization: Bearer secret_pass_123');
      });

      const result = await IntegrationExecutor.execute(webhookIntegration, {
        payload: { orderId: 'ORD_101', total: 10.0 },
      });

      expect(result.success).toBe(false);
      expect(result.error).not.toContain('secret_pass_123');
      expect(result.error).toContain('[REDACTED]');
    });
  });

  describe('Execution History and Analytics (ExecutionHistoryManager)', () => {
    it('records entries bounded to maximum limit (100 entries)', async () => {
      await ExecutionHistoryManager.clearHistory();

      for (let i = 0; i < 105; i++) {
        await ExecutionHistoryManager.recordEntry({
          id: `hist_${i}`,
          sessionId: `ses_${i}`,
          workflowId: 'wf_test',
          workflowName: 'Test Workflow',
          status: i % 2 === 0 ? 'SUCCESS' : 'FAILED',
          startTime: 1000 + i * 100,
          endTime: 1050 + i * 100,
          durationMs: 50,
          totalSteps: 5,
          executedSteps: 5,
          verifiedSteps: 3,
          recoveryAttempts: 0,
          failureCategory: i % 2 === 0 ? 'NONE' : 'UNEXPECTED',
        });
      }

      const history = await ExecutionHistoryManager.getHistory(undefined, 150);
      expect(history.length).toBe(100); // Caps at MAX_ENTRIES
    });

    it('calculates accurate duration metrics, median, and failure breakdown', async () => {
      await ExecutionHistoryManager.clearHistory();

      const durations = [100, 200, 300, 400, 500]; // median is 300, avg is 300
      for (let i = 0; i < durations.length; i++) {
        await ExecutionHistoryManager.recordEntry({
          id: `hist_m_${i}`,
          sessionId: `ses_m_${i}`,
          workflowId: 'wf_metrics',
          workflowName: 'Metrics WF',
          status: i === 4 ? 'FAILED' : 'SUCCESS',
          startTime: 1000,
          endTime: 1000 + durations[i],
          durationMs: durations[i],
          totalSteps: 3,
          executedSteps: 3,
          verifiedSteps: 2,
          recoveryAttempts: 0,
          failureCategory: i === 4 ? 'TARGET_NOT_FOUND' : 'NONE',
        });
      }

      const analytics = await ExecutionHistoryManager.getAnalytics();
      expect(analytics.totalRuns).toBe(5);
      expect(analytics.successCount).toBe(4);
      expect(analytics.failureCount).toBe(1);
      expect(analytics.averageDurationMs).toBe(300);
      expect(analytics.medianDurationMs).toBe(300);
      expect(analytics.failureBreakdown['TARGET_NOT_FOUND']).toBe(1);
    });
  });

  describe('Team Collaboration and Permissions (CollaborationManager)', () => {
    const sharedWorkflow: Workflow = {
      id: 'wf_collab_team',
      name: 'Team Shared Scraper',
      ownerId: 'user_alice_owner',
      version: 2,
      createdAt: 1000,
      updatedAt: 1000,
      steps: [
        {
          id: 'step_1',
          type: 'input',
          timestamp: 100,
          url: 'https://example.com',
          value: 'MySecretPassword123!',
          sensitive: true,
          sequence: 0,
        },
      ],
      variables: [
        {
          name: 'apiKey',
          type: 'string',
          defaultValue: 'SUPER_SECRET_KEY_999',
          sensitive: true,
        },
      ],
      collaboration: {
        isShared: true,
        members: [
          { userId: 'user_bob_editor', role: 'editor', addedAt: 1000 },
          { userId: 'user_charlie_runner', role: 'runner', addedAt: 1000 },
          { userId: 'user_dave_viewer', role: 'viewer', addedAt: 1000 },
        ],
      },
    } as any;

    it('enforces role-based permissions matrix correctly', () => {
      // Owner can do everything
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_alice_owner', 'edit').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_alice_owner', 'delete').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_alice_owner', 'share').allowed).toBe(true);

      // Editor can edit and run, but NOT delete or share
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_bob_editor', 'edit').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_bob_editor', 'run').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_bob_editor', 'delete').allowed).toBe(false);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_bob_editor', 'share').allowed).toBe(false);

      // Runner can run, but NOT edit or delete
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_charlie_runner', 'run').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_charlie_runner', 'edit').allowed).toBe(false);

      // Viewer can only export, cannot run or edit
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_dave_viewer', 'export').allowed).toBe(true);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_dave_viewer', 'run').allowed).toBe(false);
      expect(CollaborationManager.canUserPerform(sharedWorkflow, 'user_dave_viewer', 'edit').allowed).toBe(false);
    });

    it('detects concurrent revision modification conflicts', () => {
      // Base revision 1 vs current revision 2
      const conflict = CollaborationManager.checkRevisionConflict(sharedWorkflow, 1);
      expect(conflict.hasConflict).toBe(true);
      expect(conflict.message).toMatch(/modified by another session/i);

      // Base revision 2 matches
      const noConflict = CollaborationManager.checkRevisionConflict(sharedWorkflow, 2);
      expect(noConflict.hasConflict).toBe(false);
    });

    it('sanitizes sensitive step values and variable defaults before sharing', () => {
      const sanitized = CollaborationManager.sanitizeForSharing(sharedWorkflow);

      // Sensitive step value must be redacted
      expect(sanitized.steps[0].value).toBe('[REDACTED_SECRET]');

      // Sensitive variable defaultValue must be redacted
      const apiKeyVar = sanitized.variables?.find((v) => v.name === 'apiKey');
      expect(apiKeyVar?.defaultValue).toBe('[REDACTED_SECRET]');
    });
  });
});
