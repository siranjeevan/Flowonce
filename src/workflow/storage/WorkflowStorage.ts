import type { Workflow } from '../../shared/types/workflow';
import { STORAGE_KEYS, CURRENT_SCHEMA_VERSION } from './storage-keys';
import {
  validateWorkflow,
  normalizeWorkflow,
  assertValidWorkflow,
} from './schema';
import { migrateLegacyStorage, type MigrationResult } from './migration';

export interface WorkflowExportPayload {
  flowonceVersion: string;
  schemaVersion: number;
  exportedAt: string;
  count: number;
  workflows: Workflow[];
}

export interface WorkflowImportResult {
  imported: Workflow[];
  errors: string[];
}

/**
 * Centralized, strongly-typed Workflow Storage Engine for FlowOnce.
 * Acts as the single source of truth for workflow persistence in Chrome storage.
 */
export class WorkflowStorage {
  private static initPromise: Promise<void> | null = null;
  private static opQueue: Promise<unknown> = Promise.resolve();

  /**
   * Serializes storage write operations to prevent concurrent read-modify-write race conditions.
   */
  private static enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(() => operation(), () => operation());
    this.opQueue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * Helper to check for Chrome runtime errors.
   */
  private static checkRuntimeError(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
      throw new Error(`Chrome Storage Error: ${chrome.runtime.lastError.message}`);
    }
  }

  /**
   * Deep clones data to avoid shared in-memory references.
   */
  private static clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Ensures storage is migrated and ready for operations.
   * Safe to call concurrently from multiple contexts.
   */
  public static async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const migration = await migrateLegacyStorage(false);
        if (!migration.success) {
          console.warn('[WorkflowStorage] Storage migration reported warnings:', migration.errors);
        }
      } catch (err) {
        console.error('[WorkflowStorage] Critical initialization error:', err);
        throw err;
      }
    })();

    return this.initPromise;
  }

  /**
   * Explicitly triggers storage migration.
   */
  public static async migrateStorage(force: boolean = false): Promise<MigrationResult> {
    return migrateLegacyStorage(force);
  }

  /**
   * Retrieves all workflows from canonical storage.
   */
  public static async getAllWorkflows(): Promise<Workflow[]> {
    await this.ensureInitialized();

    const data = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
    this.checkRuntimeError();

    const rawList = data[STORAGE_KEYS.WORKFLOWS];
    if (!Array.isArray(rawList)) {
      return [];
    }

    const validWorkflows: Workflow[] = [];
    for (const item of rawList) {
      const validation = validateWorkflow(item);
      if (validation.valid) {
        validWorkflows.push(this.clone(item as Workflow));
      } else {
        console.warn(`[WorkflowStorage] Skipping malformed workflow in storage:`, validation.errors);
      }
    }

    return validWorkflows;
  }

  /**
   * Retrieves a single workflow by ID.
   */
  public static async getWorkflowById(id: string): Promise<Workflow | null> {
    if (!id || typeof id !== 'string') return null;
    const workflows = await this.getAllWorkflows();
    const found = workflows.find((w) => w.id === id.trim());
    return found ? this.clone(found) : null;
  }

  public static async getWorkflow(id: string): Promise<Workflow | null> {
    return this.getWorkflowById(id);
  }

  /**
   * Creates and persists a new workflow.
   * Validates schema and normalizes before writing.
   */
  public static async createWorkflow(rawWorkflow: Workflow): Promise<Workflow> {
    await this.ensureInitialized();

    return this.enqueue(async () => {
      const normalized = normalizeWorkflow(rawWorkflow);
      assertValidWorkflow(normalized);

      const data = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
      this.checkRuntimeError();

      const workflows = ((data[STORAGE_KEYS.WORKFLOWS] as Workflow[]) || []).slice();
      const existingIndex = workflows.findIndex((w) => w.id === normalized.id);

      if (existingIndex >= 0) {
        workflows[existingIndex] = normalized;
      } else {
        workflows.push(normalized);
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.WORKFLOWS]: workflows });
      this.checkRuntimeError();

      return this.clone(normalized);
    });
  }

  /**
   * Updates an existing workflow by ID with partial updates.
   */
  public static async updateWorkflow(
    id: string,
    updates: Partial<Omit<Workflow, 'id'>>
  ): Promise<Workflow> {
    await this.ensureInitialized();

    if (!id || typeof id !== 'string') {
      throw new Error('updateWorkflow requires a non-empty string workflow ID');
    }

    return this.enqueue(async () => {
      const data = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
      this.checkRuntimeError();

      const workflows = ((data[STORAGE_KEYS.WORKFLOWS] as Workflow[]) || []).slice();
      const index = workflows.findIndex((w) => w.id === id);

      if (index === -1) {
        throw new Error(`Workflow with ID '${id}' not found`);
      }

      const existing = workflows[index];
      const merged: Workflow = {
        ...existing,
        ...updates,
        id: existing.id, // ID must remain immutable
        updatedAt: new Date().toISOString(),
      };

      const normalized = normalizeWorkflow(merged);
      assertValidWorkflow(normalized);

      workflows[index] = normalized;
      await chrome.storage.local.set({ [STORAGE_KEYS.WORKFLOWS]: workflows });
      this.checkRuntimeError();

      return this.clone(normalized);
    });
  }

  /**
   * Deletes a workflow by ID.
   * Preserves all other workflows.
   */
  public static async deleteWorkflow(id: string): Promise<boolean> {
    await this.ensureInitialized();

    if (!id || typeof id !== 'string') return false;

    return this.enqueue(async () => {
      const data = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
      this.checkRuntimeError();

      const workflows = ((data[STORAGE_KEYS.WORKFLOWS] as Workflow[]) || []).slice();
      const initialLength = workflows.length;
      const filtered = workflows.filter((w) => w.id !== id);

      if (filtered.length === initialLength) {
        return false; // Nothing was deleted
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.WORKFLOWS]: filtered });
      this.checkRuntimeError();

      return true;
    });
  }

  /**
   * Replaces the entire workflows array.
   * Every workflow is validated before saving.
   */
  public static async replaceAllWorkflows(workflows: Workflow[]): Promise<void> {
    await this.ensureInitialized();

    return this.enqueue(async () => {
      if (!Array.isArray(workflows)) {
        throw new Error('replaceAllWorkflows requires an array');
      }

      const validatedList: Workflow[] = [];
      for (let i = 0; i < workflows.length; i++) {
        const normalized = normalizeWorkflow(workflows[i]);
        assertValidWorkflow(normalized);
        validatedList.push(normalized);
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.WORKFLOWS]: validatedList });
      this.checkRuntimeError();
    });
  }

  /**
   * Exports all workflows as a canonical JSON string.
   * By default, redacts sensitive variable defaults and sensitive step values
   * to protect user credentials and secret keys from exposure in exported files.
   */
  public static async exportWorkflows(
    options: { redactSensitive?: boolean } = { redactSensitive: true }
  ): Promise<string> {
    const workflows = await this.getAllWorkflows();
    const shouldRedact = options.redactSensitive !== false;

    const exportedWorkflows = workflows.map((wf) => {
      if (!shouldRedact) return wf;
      const sanitized = this.clone(wf);
      if (sanitized.steps) {
        sanitized.steps = sanitized.steps.map((st) => {
          if (st.sensitive) {
            return { ...st, value: undefined };
          }
          return st;
        });
      }
      if (sanitized.variables) {
        sanitized.variables = sanitized.variables.map((v) => {
          if (v.sensitive) {
            return { ...v, defaultValue: undefined };
          }
          return v;
        });
      }
      return sanitized;
    });

    const payload: WorkflowExportPayload = {
      flowonceVersion: '2.0.0',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      count: exportedWorkflows.length,
      workflows: exportedWorkflows,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Imports workflows from a JSON string or parsed object/array.
   * Validates every item, handles backward-compatible formats, and avoids corrupting existing storage.
   */
  public static async importWorkflows(data: string | unknown): Promise<WorkflowImportResult> {
    await this.ensureInitialized();

    let parsed: unknown = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        return {
          imported: [],
          errors: [`Failed to parse JSON import: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }

    let candidates: unknown[] = [];
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed)) {
        candidates = parsed;
      } else if ('workflows' in parsed && Array.isArray((parsed as Record<string, unknown>).workflows)) {
        candidates = (parsed as Record<string, unknown>).workflows as unknown[];
      } else {
        candidates = [parsed];
      }
    }

    if (candidates.length === 0) {
      return {
        imported: [],
        errors: ['No workflows found in import payload'],
      };
    }

    const imported: Workflow[] = [];
    const errors: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const normalized = normalizeWorkflow(candidate);
        assertValidWorkflow(normalized);
        imported.push(normalized);
      } catch (err) {
        errors.push(`Candidate [${i}] validation error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (imported.length > 0) {
      await this.enqueue(async () => {
        const existingData = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
        const currentList = ((existingData[STORAGE_KEYS.WORKFLOWS] as Workflow[]) || []).slice();

        for (const item of imported) {
          const idx = currentList.findIndex((w) => w.id === item.id);
          if (idx >= 0) {
            currentList[idx] = item;
          } else {
            currentList.push(item);
          }
        }

        await chrome.storage.local.set({ [STORAGE_KEYS.WORKFLOWS]: currentList });
        this.checkRuntimeError();
      });
    }

    return {
      imported,
      errors,
    };
  }

  /**
   * Testing hook: Resets internal initialization state.
   */
  public static _resetInitialization(): void {
    this.initPromise = null;
    this.opQueue = Promise.resolve();
  }
}
