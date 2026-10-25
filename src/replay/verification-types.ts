import type { ActionType, TargetDescriptor } from '../shared/types/workflow';

/**
 * High-level verification outcome for a workflow action.
 */
export type VerificationStatus =
  | 'VERIFIED'
  | 'NOT_VERIFIED'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED'
  | 'ERROR';

/**
 * Strategy used to determine whether the action succeeded.
 */
export type VerificationStrategy =
  | 'auto'
  | 'none'
  | 'element_visible'
  | 'element_absent'
  | 'value_match'
  | 'checked_state'
  | 'url_match'
  | 'url_changed'
  | 'text_match'
  | 'attribute_match'
  | 'custom';

/**
 * Supported observable postconditions.
 */
export type PostconditionType =
  | 'element_exists'
  | 'element_visible'
  | 'element_absent'
  | 'element_enabled'
  | 'element_disabled'
  | 'text_equals'
  | 'text_contains'
  | 'attribute_equals'
  | 'value_equals'
  | 'checked_equals'
  | 'url_equals'
  | 'url_matches'
  | 'url_changed'
  | 'custom';

/**
 * Descriptor defining an expected postcondition.
 */
export interface PostconditionDescriptor {
  type: PostconditionType;
  target?: TargetDescriptor;
  expectedValue?: string | boolean | number;
  attributeName?: string;
  urlPattern?: string;
  customDescription?: string;
}

/**
 * Step-level verification policy.
 */
export interface StepVerificationConfig {
  enabled: boolean;
  strategy?: VerificationStrategy;
  postcondition?: PostconditionDescriptor;
  timeoutMs?: number;
  pauseOnFailure?: boolean;
  requireUserRecoveryOnUncertain?: boolean;
}

/**
 * Eligibility of an action for automated retries.
 */
export type RetryEligibility =
  | 'NONE'
  | 'VERIFY_ONLY'
  | 'SAFE_ACTION_RETRY';

/**
 * Structured verification report produced by ActionVerifier.
 */
export interface VerificationResult {
  verificationId: string;
  sessionId?: string;
  actionId?: string;
  actionType: ActionType;
  status: VerificationStatus;
  method: string;
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  expectedCondition?: string;
  actualState?: string;
  diagnosticInfo?: string;
  retryEligibility: RetryEligibility;
  recoveryRecommendation?: string;
  error?: string;
}

/**
 * Execution and evaluation context passed to verification helpers.
 */
export interface EvaluationContext {
  signal?: AbortSignal;
  sessionId?: string;
  workflowId?: string;
  actionId?: string;
  stepIndex?: number;
  initialUrl?: string;
  initialValue?: string | null;
  targetElement?: HTMLElement | null;
  speedMultiplier?: number;
}
