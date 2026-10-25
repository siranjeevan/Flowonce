import {
  STORAGE_KEYS,
  CURRENT_SESSION_SCHEMA_VERSION,
} from '../../workflow/storage/storage-keys';
import type {
  ReplaySession,
  ReplaySessionStatus,
  ActionExecutionState,
  ReplayDiagnosticEventType,
  ReplayDiagnosticEvent,
  ReplaySessionValidationResult,
} from './session-types';

export const VALID_SESSION_STATUSES: ReadonlySet<ReplaySessionStatus> = new Set([
  'STARTING',
  'RUNNING',
  'WAITING',
  'NAVIGATING',
  'PAUSED',
  'STOPPING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'RECOVERY_REQUIRED',
]);

export const VALID_ACTION_STATES: ReadonlySet<ActionExecutionState> = new Set([
  'NOT_STARTED',
  'PREPARING',
  'DISPATCHING',
  'VERIFYING',
  'VERIFIED',
  'OUTCOME_UNKNOWN',
  'FAILED',
]);

/**
 * Validates a runtime object against the ReplaySession schema.
 */
export function validateReplaySession(raw: unknown): ReplaySessionValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Session payload must be a non-null object'] };
  }

  const s = raw as Record<string, unknown>;

  if (typeof s.sessionId !== 'string' || !s.sessionId.trim()) {
    errors.push('Missing or invalid sessionId');
  }

  if (typeof s.workflowId !== 'string' || !s.workflowId.trim()) {
    errors.push('Missing or invalid workflowId');
  }

  if (typeof s.workflowName !== 'string') {
    errors.push('Missing or invalid workflowName');
  }

  if (typeof s.totalSteps !== 'number' || s.totalSteps < 0) {
    errors.push('totalSteps must be a non-negative number');
  }

  if (typeof s.currentStepIndex !== 'number' || s.currentStepIndex < 0) {
    errors.push('currentStepIndex must be a non-negative number');
  }

  if (typeof s.lastCompletedStepIndex !== 'number') {
    errors.push('lastCompletedStepIndex must be a number');
  }

  if (!s.status || !VALID_SESSION_STATUSES.has(s.status as ReplaySessionStatus)) {
    errors.push(`Invalid status: ${String(s.status)}`);
  }

  if (!s.actionState || !VALID_ACTION_STATES.has(s.actionState as ActionExecutionState)) {
    errors.push(`Invalid actionState: ${String(s.actionState)}`);
  }

  if (typeof s.sessionRevision !== 'number') {
    errors.push('sessionRevision must be a number');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitizes diagnostic details to redact passwords, tokens, and credentials.
 */
export function sanitizeDiagnosticText(text?: string): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/(password\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-zA-Z0-9_.-]+/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,]+)/gi, '$1[REDACTED]');
}

/**
 * Dedicated persistence layer for FlowOnce Replay Sessions.
 * Manages atomic writes, optimistic revisions, and safe recovery boundaries.
 */
export class ReplaySessionStorage {
  private static writeQueue: Promise<unknown> = Promise.resolve();

  private static enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op, op);
    this.writeQueue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /**
   * Retrieves the current active replay session from storage.
   * Returns null if no session exists or if the session record is corrupted.
   */
  public static async getActiveSession(): Promise<ReplaySession | null> {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return null;
      }

      const res = await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_SESSION]);
      const raw = res[STORAGE_KEYS.ACTIVE_SESSION];
      if (!raw) return null;

      const validation = validateReplaySession(raw);
      if (!validation.valid) {
        console.warn(
          '[ReplaySessionStorage] Corrupted active session found:',
          validation.errors
        );
        return null;
      }

      return raw as ReplaySession;
    } catch (err) {
      console.error('[ReplaySessionStorage] Failed to read active session:', err);
      return null;
    }
  }

  private static async persistSessionDirect(session: ReplaySession): Promise<ReplaySession> {
    const updated: ReplaySession = {
      ...session,
      sessionRevision: (session.sessionRevision || 0) + 1,
      updatedAt: Date.now(),
      sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };

    const validation = validateReplaySession(updated);
    if (!validation.valid) {
      throw new Error(
        `Cannot persist invalid replay session: ${validation.errors.join(', ')}`
      );
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.ACTIVE_SESSION]: updated,
        [STORAGE_KEYS.SESSION_SCHEMA_VERSION]: CURRENT_SESSION_SCHEMA_VERSION,
      });
    }

    return updated;
  }

  /**
   * Persists or updates the active replay session atomically.
   */
  public static async saveSession(session: ReplaySession): Promise<ReplaySession> {
    return this.enqueue(() => this.persistSessionDirect(session));
  }

  /**
   * Performs an atomic update on the active session.
   */
  public static async updateSession(
    updater: (current: ReplaySession) => ReplaySession
  ): Promise<ReplaySession | null> {
    return this.enqueue(async () => {
      const current = await this.getActiveSession();
      if (!current) return null;

      const modified = updater({ ...current });
      return this.persistSessionDirect(modified);
    });
  }

  /**
   * Clears the active session and archives it into historical storage.
   */
  public static async clearActiveSession(archiveReason?: ReplaySessionStatus): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

        const current = await this.getActiveSession();
        if (current) {
          const archivedSession: ReplaySession = {
            ...current,
            status: archiveReason || current.status,
            updatedAt: Date.now(),
          };

          const histData = await chrome.storage.local.get([STORAGE_KEYS.SESSION_HISTORY]);
          const history = (histData[STORAGE_KEYS.SESSION_HISTORY] as ReplaySession[]) || [];
          history.unshift(archivedSession);

          // Retain up to 10 most recent archived sessions
          const trimmedHistory = history.slice(0, 10);

          await chrome.storage.local.set({
            [STORAGE_KEYS.SESSION_HISTORY]: trimmedHistory,
          });
        }

        await chrome.storage.local.remove([STORAGE_KEYS.ACTIVE_SESSION]);
      } catch (err) {
        console.error('[ReplaySessionStorage] Failed to clear active session:', err);
      }
    });
  }

  /**
   * Appends a correlated event to the session's diagnostic log, capping at 30 events.
   */
  public static appendEvent(
    session: ReplaySession,
    type: ReplayDiagnosticEventType,
    details?: string,
    errorCode?: string
  ): void {
    const event: ReplayDiagnosticEvent = {
      type,
      timestamp: Date.now(),
      stepIndex: session.currentStepIndex,
      actionId: session.currentActionId || undefined,
      details: sanitizeDiagnosticText(details),
      errorCode,
    };

    session.eventLog = session.eventLog || [];
    session.eventLog.push(event);

    if (session.eventLog.length > 30) {
      session.eventLog = session.eventLog.slice(-30);
    }
  }
}
