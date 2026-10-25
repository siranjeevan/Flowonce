import type { Workflow } from '../../shared/types/workflow';
import {
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS,
  CURRENT_SCHEMA_VERSION,
} from './storage-keys';
import { normalizeWorkflow, validateWorkflow, type ValidationError } from './schema';

export interface ConflictRecord {
  workflowId: string;
  chosenVersion: 'canonical' | 'legacy_workflows' | 'legacy_flowonce';
  reason: string;
  discardedPayload: unknown;
  timestamp: string;
}

export interface CorruptedRecord {
  source: string;
  rawPayload: unknown;
  errors: ValidationError[];
  timestamp: string;
}

export interface MigrationBackup {
  migratedAt: string;
  schemaVersion: number;
  sourceCounts: {
    legacyWorkflows: number;
    legacyFlowonce: number;
    canonicalBeforeMigration: number;
  };
  totalReconciled: number;
  conflicts: ConflictRecord[];
  corruptedRecords: CorruptedRecord[];
}

export interface MigrationResult {
  success: boolean;
  alreadyMigrated: boolean;
  migratedCount: number;
  conflictsResolved: number;
  corruptedCount: number;
  errors: string[];
  backup?: MigrationBackup;
}

interface RawCandidate {
  source: 'canonical' | 'legacy_workflows' | 'legacy_flowonce';
  raw: unknown;
}

/**
 * Parses raw storage data into an array of unknown records.
 */
function parseRawList(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      return [];
    }
  }
  if (val && typeof val === 'object') {
    return [val];
  }
  return [];
}

/**
 * Compares two ISO or parseable timestamp strings, returning > 0 if a is newer.
 */
function compareTimestamps(a?: string | number, b?: string | number): number {
  const timeA = typeof a === 'number' ? a : Date.parse(String(a || '')) || 0;
  const timeB = typeof b === 'number' ? b : Date.parse(String(b || '')) || 0;
  return timeA - timeB;
}

/**
 * Resolves conflict between two candidates sharing the same workflow ID.
 * Returns the winning candidate, the discarded candidate, and the reason.
 */
function resolveConflict(
  a: RawCandidate,
  b: RawCandidate
): { winner: RawCandidate; loser: RawCandidate; reason: string } {
  const jsonA = JSON.stringify(a.raw);
  const jsonB = JSON.stringify(b.raw);

  if (jsonA === jsonB) {
    // Identical contents - prefer canonical over legacy
    return {
      winner: a.source === 'canonical' ? a : b,
      loser: a.source === 'canonical' ? b : a,
      reason: 'Identical records deduplicated',
    };
  }

  const objA = (typeof a.raw === 'object' && a.raw !== null ? a.raw : {}) as Record<string, unknown>;
  const objB = (typeof b.raw === 'object' && b.raw !== null ? b.raw : {}) as Record<string, unknown>;

  const stepsA = Array.isArray(objA.steps) ? objA.steps : [];
  const stepsB = Array.isArray(objB.steps) ? objB.steps : [];

  // If one has valid steps and the other has empty steps, prefer the one with steps
  if (stepsA.length > 0 && stepsB.length === 0) {
    return {
      winner: a,
      loser: b,
      reason: `Preferred version from ${a.source} with ${stepsA.length} steps over empty steps from ${b.source}`,
    };
  }
  if (stepsB.length > 0 && stepsA.length === 0) {
    return {
      winner: b,
      loser: a,
      reason: `Preferred version from ${b.source} with ${stepsB.length} steps over empty steps from ${a.source}`,
    };
  }

  // Compare updatedAt or createdAt timestamps
  const tsA = objA.updatedAt || objA.createdAt;
  const tsB = objB.updatedAt || objB.createdAt;
  const timeDiff = compareTimestamps(tsA as string, tsB as string);

  if (timeDiff > 0) {
    return {
      winner: a,
      loser: b,
      reason: `Preferred version from ${a.source} with newer timestamp (${String(tsA)}) vs ${b.source} (${String(tsB)})`,
    };
  } else if (timeDiff < 0) {
    return {
      winner: b,
      loser: a,
      reason: `Preferred version from ${b.source} with newer timestamp (${String(tsB)}) vs ${a.source} (${String(tsA)})`,
    };
  }

  // If timestamps are tied, prefer higher step count
  if (stepsA.length >= stepsB.length) {
    return {
      winner: a,
      loser: b,
      reason: `Timestamps tied, preferred ${a.source} with ${stepsA.length} steps`,
    };
  } else {
    return {
      winner: b,
      loser: a,
      reason: `Timestamps tied, preferred ${b.source} with ${stepsB.length} steps`,
    };
  }
}

/**
 * Performs a comprehensive, idempotent, backward-compatible migration of legacy workflow storage.
 * Reads legacy keys ('workflows', 'flowonce_workflows') and canonical ('flowonce.workflows'),
 * normalizes schemas, safely resolves conflicts, records a backup snapshot, writes to canonical storage,
 * and verifies write integrity before marking complete.
 */
export async function migrateLegacyStorage(force: boolean = false): Promise<MigrationResult> {
  const errors: string[] = [];
  const conflicts: ConflictRecord[] = [];
  const corruptedRecords: CorruptedRecord[] = [];

  try {
    // 1. Read existing data from all possible locations
    const storageKeysToRead = [
      STORAGE_KEYS.WORKFLOWS,
      STORAGE_KEYS.SCHEMA_VERSION,
      LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS,
      LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS,
    ];

    const data = await chrome.storage.local.get(storageKeysToRead);

    const existingSchemaVersion = data[STORAGE_KEYS.SCHEMA_VERSION];
    const canonicalRaw = parseRawList(data[STORAGE_KEYS.WORKFLOWS]);
    const legacyWorkflowsRaw = parseRawList(data[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS]);
    const legacyFlowonceRaw = parseRawList(data[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS]);

    // Check idempotency: if already schema version 2 and all legacy workflows are accounted for
    if (!force && existingSchemaVersion === CURRENT_SCHEMA_VERSION) {
      const canonicalIds = new Set(
        canonicalRaw
          .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
          .map((w) => (typeof w.id === 'string' ? w.id.trim() : ''))
          .filter(Boolean)
      );

      const hasNewLegacy =
        legacyWorkflowsRaw.some((w) => {
          if (!w || typeof w !== 'object') return false;
          const id = (w as Record<string, unknown>).id;
          return typeof id === 'string' && !canonicalIds.has(id.trim());
        }) ||
        legacyFlowonceRaw.some((w) => {
          if (!w || typeof w !== 'object') return false;
          const id = (w as Record<string, unknown>).id;
          return typeof id === 'string' && !canonicalIds.has(id.trim());
        });

      if (!hasNewLegacy) {
        return {
          success: true,
          alreadyMigrated: true,
          migratedCount: canonicalRaw.length,
          conflictsResolved: 0,
          corruptedCount: 0,
          errors: [],
        };
      }
    }

    // 2. Gather candidates from all sources
    const allCandidates: RawCandidate[] = [
      ...canonicalRaw.map((raw): RawCandidate => ({ source: 'canonical', raw })),
      ...legacyWorkflowsRaw.map((raw): RawCandidate => ({ source: 'legacy_workflows', raw })),
      ...legacyFlowonceRaw.map((raw): RawCandidate => ({ source: 'legacy_flowonce', raw })),
    ];

    if (allCandidates.length === 0) {
      // Clean state, just stamp schema version
      await chrome.storage.local.set({
        [STORAGE_KEYS.WORKFLOWS]: [],
        [STORAGE_KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION,
      });

      return {
        success: true,
        alreadyMigrated: false,
        migratedCount: 0,
        conflictsResolved: 0,
        corruptedCount: 0,
        errors: [],
      };
    }

    // 3. Group candidates by workflow ID
    const groupedById = new Map<string, RawCandidate[]>();
    let generatedIdCounter = 0;

    for (const candidate of allCandidates) {
      let id: string | undefined;
      if (candidate.raw && typeof candidate.raw === 'object' && 'id' in candidate.raw) {
        const candidateId = (candidate.raw as Record<string, unknown>).id;
        if (typeof candidateId === 'string' && candidateId.trim()) {
          id = candidateId.trim();
        }
      }

      if (!id) {
        generatedIdCounter++;
        id = `MIGRATED_UNIDENTIFIED_${Date.now()}_${generatedIdCounter}`;
      }

      const list = groupedById.get(id) || [];
      list.push(candidate);
      groupedById.set(id, list);
    }

    // 4. Reconcile conflicts and normalize
    const reconciledWorkflows: Workflow[] = [];

    for (const [id, candidates] of groupedById.entries()) {
      let winningCandidate: RawCandidate = candidates[0];

      if (candidates.length > 1) {
        // Resolve conflicts pairwise
        for (let i = 1; i < candidates.length; i++) {
          const nextCandidate = candidates[i];
          const resolution = resolveConflict(winningCandidate, nextCandidate);

          conflicts.push({
            workflowId: id,
            chosenVersion: resolution.winner.source,
            reason: resolution.reason,
            discardedPayload: resolution.loser.raw,
            timestamp: new Date().toISOString(),
          });

          winningCandidate = resolution.winner;
        }
      }

      // 5. Normalize and validate winning candidate
      try {
        const normalized = normalizeWorkflow(winningCandidate.raw);
        reconciledWorkflows.push(normalized);
      } catch (normErr: unknown) {
        const validation = validateWorkflow(winningCandidate.raw);
        corruptedRecords.push({
          source: winningCandidate.source,
          rawPayload: winningCandidate.raw,
          errors: validation.errors.length > 0
            ? validation.errors
            : [{ field: 'workflow', message: String(normErr) }],
          timestamp: new Date().toISOString(),
        });
        errors.push(`Workflow ${id} failed normalization: ${String(normErr)}`);
      }
    }

    // 6. Create migration backup metadata
    const backup: MigrationBackup = {
      migratedAt: new Date().toISOString(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sourceCounts: {
        legacyWorkflows: legacyWorkflowsRaw.length,
        legacyFlowonce: legacyFlowonceRaw.length,
        canonicalBeforeMigration: canonicalRaw.length,
      },
      totalReconciled: reconciledWorkflows.length,
      conflicts,
      corruptedRecords,
    };

    // 7. Write migrated workflows and backup to canonical storage
    await chrome.storage.local.set({
      [STORAGE_KEYS.WORKFLOWS]: reconciledWorkflows,
      [STORAGE_KEYS.MIGRATION_BACKUP]: backup,
    });

    // 8. Read back and verify the written data (Step 10 in requirements)
    const verificationData = await chrome.storage.local.get([STORAGE_KEYS.WORKFLOWS]);
    const writtenList = verificationData[STORAGE_KEYS.WORKFLOWS] as Workflow[] | undefined;

    if (!Array.isArray(writtenList)) {
      throw new Error('Verification failed: Written workflows is not an array.');
    }

    if (writtenList.length !== reconciledWorkflows.length) {
      throw new Error(
        `Verification failed: Written count (${writtenList.length}) does not match expected (${reconciledWorkflows.length}).`
      );
    }

    // Verify all IDs match
    const writtenIds = new Set(writtenList.map((w) => w.id));
    for (const w of reconciledWorkflows) {
      if (!writtenIds.has(w.id)) {
        throw new Error(`Verification failed: Missing workflow ID '${w.id}' in verified storage.`);
      }
    }

    // 9. Mark migration complete only after successful verification
    await chrome.storage.local.set({
      [STORAGE_KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION,
    });

    return {
      success: true,
      alreadyMigrated: false,
      migratedCount: reconciledWorkflows.length,
      conflictsResolved: conflicts.length,
      corruptedCount: corruptedRecords.length,
      errors,
      backup,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    errors.push(`Migration failure: ${errorMsg}`);
    return {
      success: false,
      alreadyMigrated: false,
      migratedCount: 0,
      conflictsResolved: conflicts.length,
      corruptedCount: corruptedRecords.length,
      errors,
    };
  }
}
