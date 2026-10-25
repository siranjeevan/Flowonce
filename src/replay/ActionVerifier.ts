import type { WorkflowStep, ActionType } from '../shared/types/workflow';
import type {
  VerificationResult,
  EvaluationContext,
  PostconditionDescriptor,
} from './verification-types';
import { PostconditionEvaluator } from './PostconditionEvaluator';
import { sanitizeDiagnosticText } from './session/ReplaySessionStorage';

/**
 * Explicit classification of action safety and side-effect retry semantics.
 */
export type ActionSafetyCategory =
  | 'SET_VALUE_KNOWN_STATE'   // input, select, radio, checkbox with explicit boolean value
  | 'TOGGLE_STATE'            // checkbox toggle without explicit boolean value
  | 'EXTERNAL_SIDE_EFFECT'    // clicks on buttons/links/submits, keypress Enter, drag, navigation
  | 'READ_ONLY_SAFE'          // wait, scroll, extract, condition
  | 'UNCERTAIN_SIDE_EFFECT';

export function classifyActionSafety(stepOrType: ActionType | WorkflowStep): ActionSafetyCategory {
  if (typeof stepOrType === 'string') {
    switch (stepOrType) {
      case 'wait':
      case 'scroll':
      case 'extract':
      case 'condition':
        return 'READ_ONLY_SAFE';
      case 'input':
      case 'radio':
      case 'select':
      case 'checkbox':
      case 'navigate':
        return 'SET_VALUE_KNOWN_STATE';
      case 'click':
      case 'keydown':
      case 'keypress':
      case 'drag':
      default:
        return 'EXTERNAL_SIDE_EFFECT';
    }
  }

  const step = stepOrType;
  if (step.type === 'wait' || step.type === 'scroll' || step.type === 'extract' || step.type === 'condition') {
    return 'READ_ONLY_SAFE';
  }
  if (step.type === 'input' || step.type === 'radio' || step.type === 'select' || step.type === 'navigate') {
    return 'SET_VALUE_KNOWN_STATE';
  }
  if (step.type === 'checkbox') {
    return (step.value === 'true' || step.value === 'false')
      ? 'SET_VALUE_KNOWN_STATE'
      : 'TOGGLE_STATE';
  }
  return 'EXTERNAL_SIDE_EFFECT';
}

/**
 * Determines if an action type or step is intrinsically safe to repeat.
 * Setting a value to a known state (or read-only actions) is safe to repeat.
 * State toggles and external side effects (e.g. clicks, form submissions)
 * are NEVER safe to automatically retry without evidence that prior operation didn't take effect.
 */
export function isActionIdempotent(stepOrType: ActionType | WorkflowStep): boolean {
  const category = classifyActionSafety(stepOrType);
  return category === 'SET_VALUE_KNOWN_STATE' || category === 'READ_ONLY_SAFE';
}

/**
 * ActionVerifier coordinates postcondition verification following action dispatch.
 * Enforces action-specific policies, bounded timeouts, and strict retry eligibility.
 */
export class ActionVerifier {
  public static async verifyAction(
    step: WorkflowStep,
    targetElement: HTMLElement | null,
    context?: EvaluationContext
  ): Promise<VerificationResult> {
    const startedAt = Date.now();
    const verificationId = `VER_${startedAt}_${Math.random().toString(36).substring(2, 8)}`;
    const actionId = context?.actionId || `${context?.sessionId || 'sess'}_step${context?.stepIndex ?? step.sequence}_attempt0`;

    // 1. Cancellation Check
    if (context?.signal?.aborted) {
      return {
        verificationId,
        sessionId: context?.sessionId,
        actionId,
        actionType: step.type,
        status: 'CANCELLED',
        method: 'cancellation_check',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: 0,
        expectedCondition: 'Action verification',
        actualState: 'Cancelled before verification began',
        retryEligibility: 'NONE',
        diagnosticInfo: 'Verification aborted by user or session stop',
      };
    }

    // 2. Explicit Verification Disablement
    if (step.verification && step.verification.enabled === false) {
      return {
        verificationId,
        sessionId: context?.sessionId,
        actionId,
        actionType: step.type,
        status: 'VERIFIED',
        method: 'verification_disabled_by_config',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: 0,
        expectedCondition: 'None (Verification disabled)',
        actualState: 'Dispatched and acknowledged',
        retryEligibility: 'NONE',
      };
    }

    if (step.verification?.strategy === 'none') {
      return {
        verificationId,
        sessionId: context?.sessionId,
        actionId,
        actionType: step.type,
        status: 'VERIFIED',
        method: 'strategy_none',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: 0,
        expectedCondition: 'None',
        actualState: 'Dispatched and acknowledged',
        retryEligibility: 'NONE',
      };
    }

    const timeoutMs = step.verification?.timeoutMs ?? 3000;

    // 3. Custom or Explicit Postcondition Evaluation
    if (step.verification?.postcondition) {
      return this.evaluatePostcondition(
        verificationId,
        step,
        step.verification.postcondition,
        targetElement,
        context,
        timeoutMs,
        'custom_configured_postcondition'
      );
    }

    // 4. Default Action-Specific Verification Policies
    switch (step.type) {
      case 'input': {
        const expectedVal = step.value ?? '';
        const postcondition: PostconditionDescriptor = {
          type: 'value_equals',
          target: step.target,
          expectedValue: expectedVal,
        };
        return this.evaluatePostcondition(
          verificationId,
          step,
          postcondition,
          targetElement,
          context,
          timeoutMs,
          'auto_input_value_match'
        );
      }

      case 'checkbox': {
        const expectedChecked = step.value === 'true';
        const postcondition: PostconditionDescriptor = {
          type: 'checked_equals',
          target: step.target,
          expectedValue: expectedChecked,
        };
        return this.evaluatePostcondition(
          verificationId,
          step,
          postcondition,
          targetElement,
          context,
          timeoutMs,
          'auto_checkbox_checked_state'
        );
      }

      case 'radio': {
        const postcondition: PostconditionDescriptor = {
          type: 'checked_equals',
          target: step.target,
          expectedValue: true,
        };
        return this.evaluatePostcondition(
          verificationId,
          step,
          postcondition,
          targetElement,
          context,
          timeoutMs,
          'auto_radio_checked_state'
        );
      }

      case 'select': {
        const expectedVal = step.value ?? '';
        const postcondition: PostconditionDescriptor = {
          type: 'value_equals',
          target: step.target,
          expectedValue: expectedVal,
        };
        return this.evaluatePostcondition(
          verificationId,
          step,
          postcondition,
          targetElement,
          context,
          timeoutMs,
          'auto_select_value_match'
        );
      }

      case 'navigate': {
        const targetUrl = step.url;
        const postcondition: PostconditionDescriptor = {
          type: 'url_matches',
          urlPattern: targetUrl,
        };
        return this.evaluatePostcondition(
          verificationId,
          step,
          postcondition,
          targetElement,
          context,
          Math.max(timeoutMs, 5000),
          'auto_navigation_destination_match'
        );
      }

      case 'wait': {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'VERIFIED',
          method: 'auto_wait_timer_elapsed',
          startedAt,
          completedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          expectedCondition: `Wait duration ${step.value || 1000}ms completed`,
          actualState: 'Timer completed without interruption',
          retryEligibility: 'NONE',
        };
      }

      case 'scroll': {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'VERIFIED',
          method: 'auto_scroll_settled',
          startedAt,
          completedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          expectedCondition: 'Scroll target reached and view settled',
          actualState: 'Scroll command completed',
          retryEligibility: 'SAFE_ACTION_RETRY',
        };
      }

      case 'click': {
        // If target was a link with href, check navigation
        const link = targetElement?.closest('a') as HTMLAnchorElement | null;
        if (link && link.href && !link.href.startsWith('javascript:')) {
          const postcondition: PostconditionDescriptor = {
            type: 'url_changed',
          };
          // Bounded short check for link navigation initiation
          const outcome = await PostconditionEvaluator.evaluate(
            postcondition,
            context,
            Math.min(timeoutMs, 2000)
          );
          if (outcome.satisfied) {
            return {
              verificationId,
              sessionId: context?.sessionId,
              actionId,
              actionType: step.type,
              status: 'VERIFIED',
              method: 'auto_link_navigation_detected',
              startedAt,
              completedAt: Date.now(),
              elapsedMs: outcome.elapsedMs,
              expectedCondition: outcome.expectedCondition,
              actualState: outcome.actualState,
              retryEligibility: 'NONE',
            };
          }
        }

        // For clicks without an explicit postcondition configured:
        // Acknowledged dispatch is verified for backwards compatibility
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'VERIFIED',
          method: 'dom_dispatch_acknowledged',
          startedAt,
          completedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          expectedCondition: 'DOM event dispatch sequence acknowledged without error',
          actualState: 'Pointer and click events dispatched successfully',
          retryEligibility: 'NONE',
        };
      }

      default: {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'VERIFIED',
          method: 'default_acknowledged',
          startedAt,
          completedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          expectedCondition: 'Dispatched without unhandled error',
          actualState: 'Dispatched',
          retryEligibility: 'NONE',
        };
      }
    }
  }

  private static async evaluatePostcondition(
    verificationId: string,
    step: WorkflowStep,
    descriptor: PostconditionDescriptor,
    targetElement: HTMLElement | null,
    context: EvaluationContext | undefined,
    timeoutMs: number,
    method: string
  ): Promise<VerificationResult> {
    const startedAt = Date.now();
    const actionId = context?.actionId || `${context?.sessionId || 'sess'}_step${step.sequence}_attempt0`;
    const idempotent = isActionIdempotent(step);

    try {
      const outcome = await PostconditionEvaluator.evaluate(
        descriptor,
        { ...context, targetElement },
        timeoutMs
      );

      const completedAt = Date.now();
      const elapsedMs = outcome.elapsedMs;

      // Mask sensitive expected and actual values in diagnostics
      const expectedCondition = step.sensitive
        ? 'Input contains sensitive value ••••••••'
        : sanitizeDiagnosticText(outcome.expectedCondition);

      const actualState = step.sensitive
        ? 'Target has sensitive value ••••••••'
        : sanitizeDiagnosticText(outcome.actualState);

      if (outcome.satisfied) {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'VERIFIED',
          method,
          startedAt,
          completedAt,
          elapsedMs,
          expectedCondition,
          actualState,
          retryEligibility: 'NONE',
        };
      }

      // Condition was NOT satisfied within timeout
      // For NON-IDEMPOTENT actions (e.g. click), a timeout means outcome is UNCERTAIN!
      // The button was clicked; the server may be processing or the UI changed unexpectedly.
      // We must NOT blindly redispatch!
      if (!idempotent) {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'OUTCOME_UNKNOWN',
          method,
          startedAt,
          completedAt,
          elapsedMs,
          expectedCondition,
          actualState,
          retryEligibility: 'VERIFY_ONLY',
          recoveryRecommendation:
            'Action was dispatched but expected postcondition was not confirmed. Do not automatically repeat potentially non-idempotent action. Confirm side effect in page or resume workflow.',
          diagnosticInfo: outcome.error,
        };
      }

      // For IDEMPOTENT actions (e.g. input text, set checkbox state, scroll),
      // we can safely retry setting the state again.
      return {
        verificationId,
        sessionId: context?.sessionId,
        actionId,
        actionType: step.type,
        status: 'NOT_VERIFIED',
        method,
        startedAt,
        completedAt,
        elapsedMs,
        expectedCondition,
        actualState,
        retryEligibility: 'SAFE_ACTION_RETRY',
        recoveryRecommendation: 'Action is idempotent and safe to retry.',
        diagnosticInfo: outcome.error,
      };
    } catch (err: unknown) {
      const isCancelled =
        context?.signal?.aborted || (err as any)?.code === 'WAIT_CANCELLED';

      if (isCancelled) {
        return {
          verificationId,
          sessionId: context?.sessionId,
          actionId,
          actionType: step.type,
          status: 'CANCELLED',
          method,
          startedAt,
          completedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          expectedCondition: sanitizeDiagnosticText(descriptor.type),
          actualState: 'Verification cancelled',
          retryEligibility: 'NONE',
          diagnosticInfo: 'Verification was aborted by user or session stop',
        };
      }

      return {
        verificationId,
        sessionId: context?.sessionId,
        actionId,
        actionType: step.type,
        status: 'ERROR',
        method,
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        expectedCondition: sanitizeDiagnosticText(descriptor.type),
        actualState: 'Error during evaluation',
        retryEligibility: idempotent ? 'SAFE_ACTION_RETRY' : 'NONE',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
