import type { WorkflowStep } from '../shared/types/workflow';
import { WaitManager } from './WaitManager';
import { TargetResolver } from './TargetResolver';
import { ActionVerifier } from './ActionVerifier';
import { OutputExtractor } from './OutputExtractor';
import type { VerificationResult } from './verification-types';
import { isSafeUrl } from '../workflow/storage/schema';

export interface ExecutionOptions {
  signal?: AbortSignal;
  sessionId?: string;
  workflowId?: string;
  stepIndex?: number;
  actionId?: string;
}

export interface ExecutionResult {
  success: boolean;
  verification: VerificationResult;
  extractedValue?: { variableName: string; value: string | number | boolean | null };
  error?: string;
  code?: string;
  navigationTriggered?: boolean;
  navigatedTo?: string;
}

export class ActionExecutor {
  
  static async execute(
    step: WorkflowStep,
    speedMultiplier: number = 1,
    options?: ExecutionOptions
  ): Promise<boolean> {
    const result = await this.executeWithVerification(step, speedMultiplier, options);
    if (!result.success) {
      const err: any = new Error(result.error || 'Action execution or verification failed');
      if (result.code) err.code = result.code;
      throw err;
    }
    return true;
  }

  static async executeWithVerification(
    step: WorkflowStep,
    speedMultiplier: number = 1,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const actionId =
      options?.actionId ||
      `${options?.sessionId || 'sess'}_step${options?.stepIndex ?? step.sequence}_attempt0`;

    // Extract step execution
    if (step.type === 'extract') {
      const extConfig = step.extraction || {
        id: `ext_${step.id}`,
        type: 'text_content',
        variableName: step.value || 'extracted_val',
        target: step.target,
      };

      const extResult = await OutputExtractor.extract(extConfig, {
        signal: options?.signal,
        sessionId: options?.sessionId,
        workflowId: options?.workflowId,
        stepIndex: options?.stepIndex,
        isSensitive: step.sensitive,
      });

      const isSuccess = extResult.success || extConfig.onFailure === 'continue';
      const verification: VerificationResult = {
        verificationId: `VER_EXT_${Date.now()}`,
        sessionId: options?.sessionId,
        actionId,
        actionType: 'extract',
        status: isSuccess ? 'VERIFIED' : 'NOT_VERIFIED',
        method: 'output_extraction',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        expectedCondition: `Extract ${extConfig.type} into "${extConfig.variableName}"`,
        actualState: extResult.success ? `Value extracted: ${step.sensitive ? '••••••••' : String(extResult.value)}` : 'Extraction failed',
        retryEligibility: 'NONE',
        diagnosticInfo: extResult.diagnosticInfo,
        error: extResult.error,
      };

      return {
        success: isSuccess,
        verification,
        extractedValue: extResult.success
          ? { variableName: extResult.variableName, value: extResult.value }
          : undefined,
        error: isSuccess ? undefined : extResult.error,
      };
    }

    // Video/Wait special cases without DOM targets
    if (step.type === 'wait') {
      const waitMs = parseInt(step.value || '1000', 10) / speedMultiplier;
      await WaitManager.wait(waitMs, { signal: options?.signal });
      const verification = await ActionVerifier.verifyAction(step, null, {
        signal: options?.signal,
        sessionId: options?.sessionId,
        workflowId: options?.workflowId,
        stepIndex: options?.stepIndex,
        actionId,
        initialUrl: typeof window !== 'undefined' ? window.location?.href : '',
      });
      return {
        success: verification.status === 'VERIFIED',
        verification,
      };
    }

    if (!step.target && step.type !== 'scroll') {
      const errorMsg = 'No target specified for action';
      const verification: VerificationResult = {
        verificationId: `VER_ERR_${Date.now()}`,
        sessionId: options?.sessionId,
        actionId,
        actionType: step.type,
        status: 'ERROR',
        method: 'target_validation',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        expectedCondition: 'Target element specification',
        actualState: 'Target is undefined',
        retryEligibility: 'NONE',
        error: errorMsg,
      };
      return {
        success: false,
        verification,
        error: errorMsg,
      };
    }

    let el: HTMLElement | null = null;
    const initialUrl = typeof window !== 'undefined' ? window.location?.href : '';

    try {
      if (step.target) {
        el = await WaitManager.waitForInteractable(step.target, step.type, {
          signal: options?.signal,
          sessionId: options?.sessionId,
          workflowId: options?.workflowId,
          stepIndex: options?.stepIndex,
        });
      }
    } catch (err: unknown) {
      if (step.type === 'scroll') {
        console.warn(`[ActionExecutor] Target not found for scroll action. Falling back to window scroll.`);
        el = document.documentElement;
      } else {
        throw err;
      }
    }

    if (!el && step.type !== 'scroll') {
      const targetDesc = step.target?.text
        ? `"${step.target.text}"`
        : step.target?.selector || step.target?.id || step.target?.name || 'element';
      const errorMsg = `Could not find interactable ${targetDesc}`;
      const verification: VerificationResult = {
        verificationId: `VER_ERR_${Date.now()}`,
        sessionId: options?.sessionId,
        actionId,
        actionType: step.type,
        status: 'ERROR',
        method: 'element_interactability_resolution',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        expectedCondition: `Interactable element ${targetDesc}`,
        actualState: 'Element not interactable',
        retryEligibility: 'NONE',
        error: errorMsg,
      };
      return {
        success: false,
        verification,
        error: errorMsg,
      };
    }

    if (el) {
      // Ensure it's in view
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {}
      
      // Wait for scrolling to settle
      try {
        await WaitManager.waitForStableElement(el, { signal: options?.signal });
      } catch {
        // If stability wait times out or fails, proceed to revalidation
      }

      // Revalidate element staleness immediately before execution
      if (!el.isConnected && step.target) {
        console.warn(`[ActionExecutor] Element became detached during scroll. Re-resolving...`);
        el = await WaitManager.waitForInteractable(step.target, step.type, {
          signal: options?.signal,
          sessionId: options?.sessionId,
          workflowId: options?.workflowId,
          stepIndex: options?.stepIndex,
        });
      }

      // Pre-execution hit testing for click actions
      if (step.type === 'click' && el) {
        const hit = TargetResolver.checkHitTarget(el);
        if (hit.isObstructed && step.target) {
          console.warn(`[ActionExecutor] Element obstructed before click: ${hit.reason}. Re-waiting for unobstructed interaction...`);
          el = await WaitManager.waitForInteractable(step.target, step.type, {
            signal: options?.signal,
            sessionId: options?.sessionId,
            workflowId: options?.workflowId,
            stepIndex: options?.stepIndex,
            timeoutMs: 3000,
          });
        }
      }
    }

    // Capture initial value before dispatching if input/textarea
    let initialValue: string | undefined;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      initialValue = el.value;
    }

    let dispatchSuccess = false;
    switch (step.type) {
      case 'click':
        dispatchSuccess = el ? this.executeClick(el) : false;
        break;
      case 'input':
        dispatchSuccess = el ? this.executeInput(el, step.value || '') : false;
        break;
      case 'keypress':
      case 'keydown':
        dispatchSuccess = el ? this.executeKeypress(el, step.key || '') : false;
        break;
      case 'checkbox':
        dispatchSuccess = el ? this.executeCheckbox(el, step.value === 'true') : false;
        break;
      case 'radio':
        dispatchSuccess = el ? this.executeCheckbox(el, true) : false;
        break;
      case 'select':
        dispatchSuccess = el ? this.executeSelect(el, step.value || '') : false;
        break;
      case 'scroll':
        dispatchSuccess = await this.executeScroll(el || document.documentElement, step.position, speedMultiplier, options);
        break;
      case 'navigate': {
        const targetUrl = step.url || step.value;
        if (!targetUrl || !isSafeUrl(targetUrl)) {
          throw new Error(`Cannot navigate to unsafe or invalid URL: ${targetUrl}`);
        }
        if (typeof window !== 'undefined') {
          window.location.href = targetUrl;
        }
        dispatchSuccess = true;
        break;
      }
      default:
        console.warn('Action not implemented yet:', step.type);
        dispatchSuccess = true;
        break;
    }

    if (!dispatchSuccess) {
      const errorMsg = `DOM dispatch failed for action ${step.type}`;
      const verification: VerificationResult = {
        verificationId: `VER_ERR_${Date.now()}`,
        sessionId: options?.sessionId,
        actionId,
        actionType: step.type,
        status: 'ERROR',
        method: 'dom_dispatch',
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        expectedCondition: `Action ${step.type} dispatched without error`,
        actualState: 'DOM dispatch returned false',
        retryEligibility: 'NONE',
        error: errorMsg,
      };
      return {
        success: false,
        verification,
        error: errorMsg,
      };
    }

    // Evaluate verification postcondition
    const verification = await ActionVerifier.verifyAction(step, el, {
      signal: options?.signal,
      sessionId: options?.sessionId,
      workflowId: options?.workflowId,
      stepIndex: options?.stepIndex,
      actionId,
      initialUrl,
      initialValue,
    });

    const navUrl = (el as any)?.__flowonce_nav;
    const isVerified = verification.status === 'VERIFIED';
    return {
      success: isVerified,
      verification,
      error: isVerified ? undefined : (verification.diagnosticInfo || verification.recoveryRecommendation || verification.error),
      navigationTriggered: Boolean(navUrl),
      navigatedTo: navUrl,
    };
  }

  private static executeClick(el: HTMLElement): boolean {
    if (typeof el.focus === 'function') {
      try { el.focus(); } catch {}
    }
    
    // Find closest clickable ancestor (button, anchor, or custom role)
    const clickable = (el.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]') as HTMLElement) || el;

    if (clickable !== el && typeof clickable.focus === 'function') {
      try { clickable.focus(); } catch {}
    }

    // Dispatch a complete sequence of pointer and mouse events
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const eventType of events) {
      const event = new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        buttons: eventType === 'pointerdown' || eventType === 'mousedown' ? 1 : 0
      });
      el.dispatchEvent(event);
    }

    // If clickable parent is different, also dispatch click event directly to it
    if (clickable !== el) {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        buttons: 0
      });
      clickable.dispatchEvent(event);
    }

    // Call native click method to invoke native button actions or form submissions
    try {
      if (typeof clickable.click === 'function') {
        clickable.click();
      } else if (typeof el.click === 'function') {
        el.click();
      }
    } catch {}

    // If target is or is inside an <a> link, ensure it navigates in the current tab
    const link = (el.closest('a') as HTMLAnchorElement | null) || (clickable instanceof HTMLAnchorElement ? clickable : null);
    if (link && link.href && !link.href.startsWith('javascript:') && !link.href.startsWith('#')) {
      if (link.target === '_blank') link.target = '_self';
      try { link.click(); } catch {}

      // In SPAs and frameworks like GitHub Turbo, synthetic untrusted clicks are ignored by the framework.
      // Record intended navigation destination so background orchestrator can coordinate navigation reliably:
      try {
        if (typeof window !== 'undefined' && window.location) {
          const destUrl = new URL(link.href, window.location.href).href;
          const currentUrl = window.location.href;
          const cleanDest = destUrl.split('#')[0];
          const cleanCurrent = currentUrl.split('#')[0];
          if (cleanDest !== cleanCurrent) {
            console.log(`[ActionExecutor] Target link navigates to ${destUrl}`);
            (el as any).__flowonce_nav = destUrl;
          }
        }
      } catch {}
    }
    
    return true;
  }

  private static executeInput(el: HTMLElement, value: string): boolean {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      
      // Use prototype setter to trigger React/Vue/Angular change trackers
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else if (el.isContentEditable) {
      el.focus();
      el.innerText = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  private static executeKeypress(el: HTMLElement, key: string): boolean {
    el.focus();
    const eventParams = {
      key: key,
      code: key === 'Enter' ? 'Enter' : key,
      keyCode: key === 'Enter' ? 13 : undefined,
      which: key === 'Enter' ? 13 : undefined,
      bubbles: true,
      cancelable: true
    };

    el.dispatchEvent(new KeyboardEvent('keydown', eventParams));
    el.dispatchEvent(new KeyboardEvent('keypress', eventParams));
    el.dispatchEvent(new KeyboardEvent('keyup', eventParams));

    // Special case for Enter: if within a form, submit it
    if (key === 'Enter') {
      const form = el.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
    return true;
  }

  private static executeCheckbox(el: HTMLElement, checked: boolean): boolean {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      el.focus();
      if (el.checked !== checked) {
        el.checked = checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  private static executeSelect(el: HTMLElement, value: string): boolean {
    if (el instanceof HTMLSelectElement) {
      el.focus();
      let matched = false;
      for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].value === value || el.options[i].text.trim() === value.trim()) {
          el.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (!matched) {
        el.value = value;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  private static async executeScroll(
    el: HTMLElement,
    position?: { scrollX?: number; scrollY?: number },
    speedMultiplier: number = 1,
    options?: ExecutionOptions
  ): Promise<boolean> {
    if (!position) return false;

    // First attempt to scroll the main window
    window.scrollTo({
      left: position.scrollX || 0,
      top: position.scrollY || 0,
      behavior: 'auto'
    });

    // Also attempt to scroll the specific element
    if (el && el !== document.documentElement && el !== document.body) {
      try {
        el.scrollTo({
          left: position.scrollX || 0,
          top: position.scrollY || 0,
          behavior: 'auto'
        });
        el.scrollLeft = position.scrollX || 0;
        el.scrollTop = position.scrollY || 0;
      } catch {}
    } else {
      // If we fell back to window, also scroll any major scrollable container
      const scrollables = Array.from(document.querySelectorAll('*')).filter(e => {
        if (e === document.documentElement || e === document.body) return false;
        const style = window.getComputedStyle(e);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && e.scrollHeight > e.clientHeight;
      });
      scrollables.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      scrollables.slice(0, 3).forEach(s => {
        s.scrollLeft = position.scrollX || 0;
        s.scrollTop = position.scrollY || 0;
      });
    }

    // Wait for scroll to settle
    await WaitManager.wait(Math.max(50, 200 / speedMultiplier), { signal: options?.signal });
    return true;
  }
}
