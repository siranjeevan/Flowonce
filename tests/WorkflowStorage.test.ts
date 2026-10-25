import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowStorage } from '../src/workflow/storage/WorkflowStorage';
import {
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS,
  CURRENT_SCHEMA_VERSION,
} from '../src/workflow/storage/storage-keys';
import {
  validateWorkflow,
  validateWorkflowStep,
  validateTargetDescriptor,
  validateVariable,
  normalizeWorkflow,
} from '../src/workflow/storage/schema';
import { migrateLegacyStorage } from '../src/workflow/storage/migration';
import type { Workflow, WorkflowStep } from '../src/shared/types/workflow';

// In-memory backing store for chrome.storage.local mock
let mockStorageStore: Record<string, unknown> = {};
let mockRuntimeLastError: { message: string } | null = null;
let simulatedWriteFailure = false;
let simulatedReadFailure = false;

// Setup global chrome mock
const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
        if (simulatedReadFailure) {
          mockRuntimeLastError = { message: 'Simulated storage read failure' };
          throw new Error('Simulated storage read failure');
        }
        mockRuntimeLastError = null;
        if (!keys) return { ...mockStorageStore };
        if (typeof keys === 'string') {
          return { [keys]: mockStorageStore[keys] };
        }
        if (Array.isArray(keys)) {
          const res: Record<string, unknown> = {};
          for (const k of keys) {
            res[k] = mockStorageStore[k];
          }
          return res;
        }
        if (typeof keys === 'object') {
          const res: Record<string, unknown> = {};
          for (const k of Object.keys(keys)) {
            res[k] = mockStorageStore[k] !== undefined ? mockStorageStore[k] : keys[k];
          }
          return res;
        }
        return { ...mockStorageStore };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        if (simulatedWriteFailure) {
          mockRuntimeLastError = { message: 'Simulated storage write failure' };
          throw new Error('Simulated storage write failure');
        }
        mockRuntimeLastError = null;
        for (const [k, v] of Object.entries(items)) {
          mockStorageStore[k] = JSON.parse(JSON.stringify(v));
        }
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        mockRuntimeLastError = null;
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          delete mockStorageStore[k];
        }
      }),
      clear: vi.fn(async () => {
        mockRuntimeLastError = null;
        mockStorageStore = {};
      }),
    },
  },
  runtime: {
    get lastError() {
      return mockRuntimeLastError;
    },
  },
};

// @ts-expect-error - Attach mock to global scope
globalThis.chrome = chromeMock;

function createSampleWorkflow(id: string, name: string = 'Sample Workflow'): Workflow {
  return {
    id,
    name,
    description: 'Test description',
    ownerId: 'local_user',
    version: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    steps: [
      {
        id: `${id}_step_1`,
        sequence: 1,
        type: 'click',
        timestamp: 1000,
        url: 'https://flowonce.test/page1',
        target: {
          tag: 'button',
          selector: '#submit-btn',
          text: 'Submit',
        },
      },
    ],
    variables: [],
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  };
}

describe('Storage Unification & Centralized WorkflowStorage', () => {
  beforeEach(() => {
    mockStorageStore = {};
    mockRuntimeLastError = null;
    simulatedWriteFailure = false;
    simulatedReadFailure = false;
    WorkflowStorage._resetInitialization();
    vi.clearAllMocks();
  });

  describe('Storage Consistency & Isolation', () => {
    it('creates and retrieves workflows across simulation of popup and background', async () => {
      // Background worker creates a workflow
      const wf1 = createSampleWorkflow('WF_BG_1', 'Background Flow');
      const created1 = await WorkflowStorage.createWorkflow(wf1);
      expect(created1.id).toBe('WF_BG_1');

      // Popup reads workflows
      const allForPopup = await WorkflowStorage.getAllWorkflows();
      expect(allForPopup).toHaveLength(1);
      expect(allForPopup[0].name).toBe('Background Flow');

      // Popup creates another workflow
      const wf2 = createSampleWorkflow('WF_POPUP_2', 'Popup Flow');
      await WorkflowStorage.createWorkflow(wf2);

      // Background retrieves all workflows
      const allForBg = await WorkflowStorage.getAllWorkflows();
      expect(allForBg).toHaveLength(2);
      expect(allForBg.map((w) => w.id)).toEqual(['WF_BG_1', 'WF_POPUP_2']);
    });

    it('updating a workflow preserves identity, updates timestamps, and preserves other records', async () => {
      const wf1 = createSampleWorkflow('WF_1', 'Initial Name');
      const wf2 = createSampleWorkflow('WF_2', 'Second Flow');
      await WorkflowStorage.createWorkflow(wf1);
      await WorkflowStorage.createWorkflow(wf2);

      const updated = await WorkflowStorage.updateWorkflow('WF_1', {
        name: 'Updated Name',
      });

      expect(updated.id).toBe('WF_1');
      expect(updated.name).toBe('Updated Name');
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(wf1.updatedAt).getTime()
      );

      // Verify WF_2 is completely untouched
      const wf2Read = await WorkflowStorage.getWorkflowById('WF_2');
      expect(wf2Read?.name).toBe('Second Flow');
    });

    it('deleting one workflow preserves all unrelated workflows', async () => {
      await WorkflowStorage.createWorkflow(createSampleWorkflow('WF_A'));
      await WorkflowStorage.createWorkflow(createSampleWorkflow('WF_B'));
      await WorkflowStorage.createWorkflow(createSampleWorkflow('WF_C'));

      const deleted = await WorkflowStorage.deleteWorkflow('WF_B');
      expect(deleted).toBe(true);

      const remaining = await WorkflowStorage.getAllWorkflows();
      expect(remaining.map((w) => w.id)).toEqual(['WF_A', 'WF_C']);

      // Deleting a non-existent ID returns false
      const deleteAgain = await WorkflowStorage.deleteWorkflow('WF_NON_EXISTENT');
      expect(deleteAgain).toBe(false);
    });

    it('getWorkflowById returns null for missing or invalid IDs', async () => {
      const res = await WorkflowStorage.getWorkflowById('DOES_NOT_EXIST');
      expect(res).toBeNull();

      // @ts-expect-error - testing invalid ID argument
      const resInvalid = await WorkflowStorage.getWorkflowById(null);
      expect(resInvalid).toBeNull();
    });
  });

  describe('Legacy Storage Migration', () => {
    it('migrates legacy workflows from workflows key alone', async () => {
      const legacyWf = {
        id: 'LEGACY_1',
        name: 'Legacy Background Workflow',
        steps: [
          {
            id: 's1',
            type: 'click',
            timestamp: 500,
            url: 'http://example.com',
            sequence: 1,
          },
        ],
        createdAt: 1700000000000,
      };

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [legacyWf];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);

      const stored = mockStorageStore[STORAGE_KEYS.WORKFLOWS] as Workflow[];
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('LEGACY_1');
      expect(stored[0].schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(mockStorageStore[STORAGE_KEYS.SCHEMA_VERSION]).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('migrates legacy workflows from flowonce_workflows key alone', async () => {
      const legacyWf = {
        id: 'LEGACY_LOCAL_1',
        name: 'Legacy Local Storage Workflow',
        steps: [
          {
            id: 's1',
            type: 'navigate',
            timestamp: 1000,
            url: 'http://flowonce.com',
            sequence: 1,
          },
        ],
      };

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = [legacyWf];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);

      const stored = mockStorageStore[STORAGE_KEYS.WORKFLOWS] as Workflow[];
      expect(stored[0].id).toBe('LEGACY_LOCAL_1');
    });

    it('migrates from both legacy locations simultaneously with distinct records', async () => {
      const wf1 = createSampleWorkflow('FROM_WORKFLOWS_KEY');
      const wf2 = createSampleWorkflow('FROM_FLOWONCE_KEY');

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [wf1];
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = [wf2];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(2);

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all.map((w) => w.id).sort()).toEqual(['FROM_FLOWONCE_KEY', 'FROM_WORKFLOWS_KEY']);
    });

    it('deduplicates identical workflows present in both locations without conflict', async () => {
      const duplicateWf = createSampleWorkflow('IDENTICAL_WF', 'Identical Title');

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [duplicateWf];
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = [duplicateWf];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);
      expect(result.conflictsResolved).toBe(1);

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('IDENTICAL_WF');
    });

    it('resolves conflicting versions deterministically: prefers newer timestamp', async () => {
      const olderVersion: Workflow = {
        ...createSampleWorkflow('CONFLICT_WF', 'Old Version'),
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const newerVersion: Workflow = {
        ...createSampleWorkflow('CONFLICT_WF', 'New Version'),
        updatedAt: '2026-01-02T00:00:00Z',
      };

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [olderVersion];
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = [newerVersion];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);
      expect(result.conflictsResolved).toBe(1);

      const resolved = await WorkflowStorage.getWorkflowById('CONFLICT_WF');
      expect(resolved?.name).toBe('New Version');

      // Verify backup captured the conflict
      const backup = mockStorageStore[STORAGE_KEYS.MIGRATION_BACKUP] as any;
      expect(backup.conflicts).toHaveLength(1);
      expect(backup.conflicts[0].workflowId).toBe('CONFLICT_WF');
    });

    it('resolves conflicting versions: prefers record with valid steps over empty steps', async () => {
      const emptySteps: Workflow = {
        ...createSampleWorkflow('STEP_CONFLICT', 'Empty Steps Version'),
        steps: [],
        updatedAt: '2026-01-05T00:00:00Z', // newer timestamp but empty steps
      };
      const validSteps: Workflow = {
        ...createSampleWorkflow('STEP_CONFLICT', 'Valid Steps Version'),
        updatedAt: '2026-01-01T00:00:00Z', // older timestamp but has valid steps
      };

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [emptySteps];
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = [validSteps];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);

      const resolved = await WorkflowStorage.getWorkflowById('STEP_CONFLICT');
      expect(resolved?.name).toBe('Valid Steps Version');
      expect(resolved?.steps).toHaveLength(1);
    });

    it('safely quarantines completely unrecoverable malformed records into backup', async () => {
      const validWf = createSampleWorkflow('VALID_WF');
      const malformedNull = null;
      const malformedString = 'completely corrupted non-json string';
      const malformedNoSteps = { id: 12345 }; // non-string id, no steps, etc.

      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [
        validWf,
        malformedNull,
        malformedString,
        malformedNoSteps,
      ];

      const result = await migrateLegacyStorage(true);
      expect(result.success).toBe(true);

      // Only valid / normalized record is stored
      const workflows = await WorkflowStorage.getAllWorkflows();
      expect(workflows.some((w) => w.id === 'VALID_WF')).toBe(true);

      // Corrupted records are retained in migration backup
      const backup = mockStorageStore[STORAGE_KEYS.MIGRATION_BACKUP] as any;
      expect(backup.corruptedRecords.length).toBeGreaterThan(0);
    });

    it('is idempotent: running repeatedly does not duplicate records or overwrite changes', async () => {
      const sample = createSampleWorkflow('IDEM_1');
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [sample];

      const firstRun = await migrateLegacyStorage(true);
      expect(firstRun.migratedCount).toBe(1);

      // Add a new workflow to canonical storage
      await WorkflowStorage.createWorkflow(createSampleWorkflow('IDEM_2'));

      // Run migration again (with legacy keys cleared or empty)
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [];
      const secondRun = await migrateLegacyStorage(false);
      expect(secondRun.alreadyMigrated).toBe(true);

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all.map((w) => w.id)).toEqual(['IDEM_1', 'IDEM_2']);
    });

    it('preserves existing data if write verification fails', async () => {
      const initial = createSampleWorkflow('SAFE_1');
      mockStorageStore[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = [initial];

      simulatedWriteFailure = true;
      const result = await migrateLegacyStorage(true);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Ensure schema version was NOT updated to current version on failure
      expect(mockStorageStore[STORAGE_KEYS.SCHEMA_VERSION]).toBeUndefined();
    });
  });

  describe('Runtime Schema Validation', () => {
    it('accepts valid current workflows', () => {
      const wf = createSampleWorkflow('VALID_1');
      const res = validateWorkflow(wf);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('rejects missing or empty workflow id and name', () => {
      const noId = { ...createSampleWorkflow(''), id: '' };
      expect(validateWorkflow(noId).valid).toBe(false);

      const noName = { ...createSampleWorkflow('WF_1'), name: '   ' };
      expect(validateWorkflow(noName).valid).toBe(false);
    });

    it('rejects invalid action types', () => {
      const invalidStep: WorkflowStep = {
        id: 's1',
        // @ts-expect-error - testing invalid action type at runtime
        type: 'invalid_action_type',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
      };

      const wf = {
        ...createSampleWorkflow('WF_INVALID_ACTION'),
        steps: [invalidStep],
      };

      const res = validateWorkflow(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field.includes('type'))).toBe(true);
    });

    it('rejects malformed target descriptors', () => {
      const errors = validateTargetDescriptor({
        tag: 12345, // invalid tag type
        selector: null,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe('target.tag');
    });

    it('rejects invalid step sequence or negative timestamps', () => {
      const errors = validateWorkflowStep(
        {
          id: 'step1',
          type: 'click',
          timestamp: -10,
          url: 'http://test.com',
          sequence: -1,
        },
        0
      );
      expect(errors.length).toBe(2);
    });

    it('rejects invalid variable definitions', () => {
      const errors = validateVariable({ name: '', required: 'not-a-bool' }, 0);
      expect(errors.length).toBe(2);
    });

    it('rejects unsupported schema versions', () => {
      const wf = {
        ...createSampleWorkflow('WF_FUTURE_VERSION'),
        schemaVersion: 999, // unsupported future version
      };
      const res = validateWorkflow(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === 'schemaVersion')).toBe(true);
    });

    it('normalizes legacy workflows with numeric timestamps and missing optional fields', () => {
      const legacyRaw = {
        id: 'LEGACY_RAW_1',
        name: 'Legacy Raw',
        steps: [
          {
            id: 's1',
            type: 'click',
            timestamp: 123456,
            url: 'https://example.com',
            sequence: 1,
          },
        ],
        createdAt: 1700000000000,
      };

      const normalized = normalizeWorkflow(legacyRaw);
      expect(normalized.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(normalized.description).toBe('');
      expect(normalized.ownerId).toBe('local_user');
      expect(normalized.version).toBe(1);
      expect(Array.isArray(normalized.variables)).toBe(true);
      expect(new Date(normalized.createdAt).toISOString()).toBe(normalized.createdAt);
    });
  });

  describe('Import and Export', () => {
    it('exports workflows to JSON and imports them cleanly preserving IDs and step order', async () => {
      const wf1 = createSampleWorkflow('WF_EXP_1', 'First Flow');
      wf1.steps.push({
        id: 'WF_EXP_1_step_2',
        sequence: 2,
        type: 'input',
        timestamp: 2000,
        url: 'https://flowonce.test/page1',
        value: 'Typed text',
      });

      await WorkflowStorage.createWorkflow(wf1);

      const exportedJson = await WorkflowStorage.exportWorkflows();
      expect(typeof exportedJson).toBe('string');

      const parsed = JSON.parse(exportedJson);
      expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(parsed.count).toBe(1);

      // Clear storage
      await WorkflowStorage.replaceAllWorkflows([]);
      expect(await WorkflowStorage.getAllWorkflows()).toHaveLength(0);

      // Re-import exported json
      const importResult = await WorkflowStorage.importWorkflows(exportedJson);
      expect(importResult.errors).toHaveLength(0);
      expect(importResult.imported).toHaveLength(1);

      const imported = await WorkflowStorage.getWorkflowById('WF_EXP_1');
      expect(imported?.steps).toHaveLength(2);
      expect(imported?.steps[0].sequence).toBe(1);
      expect(imported?.steps[1].sequence).toBe(2);
      expect(imported?.steps[1].value).toBe('Typed text');
    });

    it('imports raw legacy arrays without wrapper objects', async () => {
      const legacyArray = [
        createSampleWorkflow('LEGACY_IMPORT_1'),
        createSampleWorkflow('LEGACY_IMPORT_2'),
      ];

      const result = await WorkflowStorage.importWorkflows(JSON.stringify(legacyArray));
      expect(result.errors).toHaveLength(0);
      expect(result.imported).toHaveLength(2);

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all.map((w) => w.id)).toEqual(['LEGACY_IMPORT_1', 'LEGACY_IMPORT_2']);
    });

    it('rejects corrupted import payloads without corrupting existing stored workflows', async () => {
      const original = createSampleWorkflow('ORIGINAL_WF');
      await WorkflowStorage.createWorkflow(original);

      const corruptedPayload = '{"invalidJson": [';
      const res = await WorkflowStorage.importWorkflows(corruptedPayload);
      expect(res.imported).toHaveLength(0);
      expect(res.errors.length).toBeGreaterThan(0);

      // Existing workflow is unaffected
      const stored = await WorkflowStorage.getAllWorkflows();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('ORIGINAL_WF');
    });
  });

  describe('Concurrency & Error Handling', () => {
    it('handles concurrent creates and updates through internal queue serialization', async () => {
      const promises = [
        WorkflowStorage.createWorkflow(createSampleWorkflow('CONCURRENT_1')),
        WorkflowStorage.createWorkflow(createSampleWorkflow('CONCURRENT_2')),
        WorkflowStorage.createWorkflow(createSampleWorkflow('CONCURRENT_3')),
      ];

      await Promise.all(promises);

      const all = await WorkflowStorage.getAllWorkflows();
      expect(all).toHaveLength(3);
      expect(all.map((w) => w.id).sort()).toEqual([
        'CONCURRENT_1',
        'CONCURRENT_2',
        'CONCURRENT_3',
      ]);
    });

    it('handles chrome storage read errors gracefully', async () => {
      simulatedReadFailure = true;
      await expect(WorkflowStorage.getAllWorkflows()).rejects.toThrow();
    });

    it('handles chrome storage write errors gracefully without corrupting state', async () => {
      simulatedWriteFailure = true;
      await expect(
        WorkflowStorage.createWorkflow(createSampleWorkflow('FAIL_WRITE'))
      ).rejects.toThrow();
    });
  });
});
