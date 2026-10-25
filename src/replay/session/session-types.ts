import type { VerificationResult } from '../verification-types';
import type { ActionSafetyCategory } from '../ActionVerifier';

/**
 * Types and interfaces for Persistent Replay Session Management in FlowOnce.
 */

export type ReplaySessionStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING'
  | 'NAVIGATING'
  | 'PAUSED'
  | 'STOPPING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export type ActionExecutionState =
  | 'NOT_STARTED'
  | 'PREPARING'
  | 'DISPATCHING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'OUTCOME_UNKNOWN'
  | 'FAILED';

export type ReplayDiagnosticEventType =
  | 'SESSION_CREATED'
  | 'SESSION_RESTORED'
  | 'SESSION_RECOVERY_REQUIRED'
  | 'STEP_PREPARED'
  | 'ACTION_DISPATCH_STARTED'
  | 'ACTION_ACKNOWLEDGED'
  | 'VERIFICATION_STARTED'
  | 'POSTCONDITION_VERIFIED'
  | 'POSTCONDITION_FAILED'
  | 'OUTCOME_UNCERTAIN'
  | 'STEP_CHECKPOINT_SAVED'
  | 'NAVIGATION_STARTED'
  | 'CONTENT_SCRIPT_READY'
  | 'SESSION_PAUSED'
  | 'SESSION_RESUMED'
  | 'SESSION_CANCELLED'
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'DATASET_STARTED'
  | 'DATASET_RECORD_STARTED'
  | 'DATASET_RECORD_COMPLETED'
  | 'DATASET_RECORD_FAILED'
  | 'DATASET_COMPLETED'
  | 'OUTPUT_EXTRACTED'
  | 'CONDITION_EVALUATED'
  | 'BRANCH_TAKEN'
  | 'EXECUTION_BUDGET_EXCEEDED'
  | 'RECOVERY_INSPECTION_STARTED'
  | 'RECOVERY_EVIDENCE_RECORDED'
  | 'RECOVERY_DECISION_PROCESSED'
  | 'RECOVERY_RECHECK_STARTED'
  | 'RECOVERY_RECHECK_COMPLETED';

export type RecoveryEvidenceType =
  | 'dom_postcondition'
  | 'url_observation'
  | 'target_element_state'
  | 'user_confirmation'
  | 'inconclusive';

export interface RecoveryEvidence {
  id: string;
  type: RecoveryEvidenceType;
  timestamp: number;
  stepIndex: number;
  actionId: string;
  result: 'SUCCESS' | 'FAILURE' | 'UNCERTAIN' | 'INCONCLUSIVE';
  description: string;
  source: 'AUTOMATED_CHECK' | 'USER_CONFIRMATION';
  isUserProvided: boolean;
  details?: Record<string, any>;
}

export type RecoveryDecisionType =
  | 'CONFIRM_SUCCESS'
  | 'CONFIRM_FAILURE_RETRY'
  | 'RECHECK_CONDITION'
  | 'STOP_REPLAY'
  | 'INSPECT_PAGE';

export interface RecoveryDecision {
  id: string;
  decisionType: RecoveryDecisionType;
  sessionId: string;
  workflowId: string;
  sessionRevision: number;
  stepIndex: number;
  actionId: string;
  timestamp: number;
  authorizedByUser: boolean;
  forceUnsafeRetry?: boolean;
  recordIndex?: number;
  rationale?: string;
}

export interface RecoveryContext {
  interruptedStepIndex: number;
  interruptedActionId: string;
  safetyCategory: ActionSafetyCategory;
  reason: string;
  evidence: RecoveryEvidence[];
  pendingDecision?: RecoveryDecision;
  history: RecoveryDecision[];
  lastInspection?: {
    timestamp: number;
    url?: string;
    title?: string;
    targetFound?: boolean;
    details?: string;
  };
}

export interface ReplayDiagnosticEvent {
  type: ReplayDiagnosticEventType;
  timestamp: number;
  stepIndex?: number;
  actionId?: string;
  details?: string;
  errorCode?: string;
}

export interface DatasetRecordSummary {
  index: number;
  error?: string;
  stepIndex?: number;
  outcomeUnknown?: boolean;
  executedUnsafeStep?: boolean;
}

export interface DatasetExecutionState {
  datasetId?: string;
  fingerprint: string;
  totalRecords: number;
  currentRecordIndex: number;
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED';
  completedRecords: number[];
  failedRecords: DatasetRecordSummary[];
  skippedRecords: number[];
  records?: Record<string, any>[];
  hasUnsafeActionExecutedInCurrentRecord?: boolean;
}

export interface ReplayConditionResult {
  stepIndex: number;
  matched: boolean;
  targetBranch: string;
  operator: string;
  actualValue: unknown;
  expectedValue?: unknown;
}

export interface ReplaySession {
  /** Unique session ID (e.g. SES_1729000_abc123) */
  sessionId: string;
  /** Workflow ID being executed */
  workflowId: string;
  /** Workflow display name */
  workflowName: string;
  /** Schema version of the workflow */
  workflowSchemaVersion: number;
  /** Session schema version (CURRENT_SESSION_SCHEMA_VERSION = 1) */
  sessionSchemaVersion: number;
  /** Total count of steps in the workflow */
  totalSteps: number;
  /** Chrome tab ID where the replay is executing */
  targetTabId: number | null;
  /** Current zero-based step index */
  currentStepIndex: number;
  /** Highest step index verified and completed */
  lastCompletedStepIndex: number;
  /** High-level session lifecycle status */
  status: ReplaySessionStatus;
  /** Fine-grained in-flight step execution state */
  actionState: ActionExecutionState;
  /** Unique correlation ID for the active action attempt */
  currentActionId: string | null;
  /** Number of retry/execution attempts for current step */
  attemptCount: number;
  /** Execution speed multiplier */
  speedMultiplier: number;
  /** Runtime variable mappings */
  variables: Record<string, any>;
  /** Extracted variables captured during session */
  extractedVariables?: Record<string, any>;
  /** Optional dataset execution state for dataset-driven runs */
  datasetState?: DatasetExecutionState;
  /** Execution budget counter to prevent infinite branch loops within record/scope */
  stepExecutionCount?: number;
  /** Cumulative execution counter across all steps, retries, branches, and records */
  totalStepExecutionCount?: number;
  /** Maximum execution step budget */
  maxStepBudget?: number;
  /** Result of last evaluated condition branch */
  lastConditionResult?: ReplayConditionResult | null;
  /** Whether a page navigation has been triggered and is awaiting completion */
  navigationPending: boolean;
  /** Flag set when a STOP/cancel command was issued */
  cancellationRequested: boolean;
  /** Last error message if failed */
  lastError: string | null;
  /** Last structured error code */
  lastErrorCode?: string | null;
  /** Result of last evaluated postcondition verification */
  lastVerificationResult?: VerificationResult | null;
  /** Interactive recovery inspector context if session entered RECOVERY_REQUIRED */
  recoveryContext?: RecoveryContext;
  /** Optimistic concurrency revision counter incremented on every write */
  sessionRevision: number;
  /** Timestamp when session started */
  startedAt: number;
  /** Timestamp of most recent state change */
  updatedAt: number;
  /** Correlated diagnostics log */
  eventLog: ReplayDiagnosticEvent[];
}

export interface ReplaySessionValidationResult {
  valid: boolean;
  errors: string[];
}
