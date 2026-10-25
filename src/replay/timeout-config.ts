/**
 * Timeout configuration and error definitions for FlowOnce Replay Synchronization
 */

export type WaitErrorCode =
  | 'WAIT_TIMEOUT'
  | 'WAIT_CANCELLED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'NAVIGATION_TIMEOUT';

export interface TimeoutConfig {
  /** Default timeout for general conditions (ms) */
  defaultTimeoutMs: number;
  /** Timeout for waiting for target element to appear in DOM (ms) */
  elementResolveTimeoutMs: number;
  /** Timeout for element to become visible / enabled (ms) */
  visibleTimeoutMs: number;
  /** Timeout for full-page navigation or tab reload (ms) */
  navigationTimeoutMs: number;
  /** Duration element geometry must remain stable after scrolling/animation (ms) */
  settleDelayMs: number;
  /** Fallback polling interval when MutationObserver cannot observe the change (ms) */
  pollIntervalMs: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  defaultTimeoutMs: 10000,
  elementResolveTimeoutMs: 10000,
  visibleTimeoutMs: 5000,
  navigationTimeoutMs: 20000,
  settleDelayMs: 150,
  pollIntervalMs: 50,
};

export interface WaitDiagnostics {
  sessionId?: string;
  workflowId?: string;
  stepIndex?: number;
  condition: string;
  targetDescription?: string;
  startTimestamp: number;
  elapsedMs: number;
  timeoutMs: number;
  status: 'satisfied' | 'timeout' | 'cancelled' | 'error';
  errorCode?: WaitErrorCode;
  error?: string;
}

export class WaitError extends Error {
  readonly code: WaitErrorCode;
  readonly diagnostics: WaitDiagnostics;

  constructor(message: string, code: WaitErrorCode, diagnostics: WaitDiagnostics) {
    super(message);
    this.name = 'WaitError';
    this.code = code;
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, WaitError.prototype);
  }
}
