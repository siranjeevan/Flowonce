import type { TargetDescriptor, ActionType } from '../shared/types/workflow';
import { TargetResolver, type ResolutionResult } from './TargetResolver';
import {
  DEFAULT_TIMEOUT_CONFIG,
  WaitError,
  type WaitErrorCode,
  type WaitDiagnostics,
  type TimeoutConfig,
} from './timeout-config';

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  message?: string;
  sessionId?: string;
  workflowId?: string;
  stepIndex?: number;
  targetDescription?: string;
}

/**
 * Centralized WaitManager for FlowOnce.
 * Implements condition-based synchronization using MutationObserver,
 * element readiness verification, bounded polling, and cancellation via AbortSignal.
 */
export class WaitManager {
  private static timeoutConfig: TimeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG };

  /**
   * Configures global default timeouts
   */
  public static setConfig(config: Partial<TimeoutConfig>) {
    this.timeoutConfig = { ...this.timeoutConfig, ...config };
  }

  public static getConfig(): TimeoutConfig {
    return { ...this.timeoutConfig };
  }

  /**
   * Simple cancellable delay for explicit wait steps.
   */
  public static wait(durationMs: number, options?: { signal?: AbortSignal }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(
          new WaitError('Wait was cancelled', 'WAIT_CANCELLED', {
            condition: 'wait',
            startTimestamp: Date.now(),
            elapsedMs: 0,
            timeoutMs: durationMs,
            status: 'cancelled',
            errorCode: 'WAIT_CANCELLED',
          })
        );
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(
          new WaitError('Wait was cancelled', 'WAIT_CANCELLED', {
            condition: 'wait',
            startTimestamp: Date.now(),
            elapsedMs: 0,
            timeoutMs: durationMs,
            status: 'cancelled',
            errorCode: 'WAIT_CANCELLED',
          })
        );
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, durationMs);
    });
  }

  /**
   * Core condition-based synchronization primitive.
   * Evaluates immediately, observes DOM mutations, and falls back to bounded polling.
   */
  public static async waitForCondition<T>(
    conditionFn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
    options?: WaitOptions
  ): Promise<T> {
    const startTimestamp = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.timeoutConfig.defaultTimeoutMs;
    const pollIntervalMs = options?.pollIntervalMs ?? this.timeoutConfig.pollIntervalMs;
    const conditionName = options?.message || 'custom condition';

    const createDiagnostics = (
      status: 'satisfied' | 'timeout' | 'cancelled' | 'error',
      errorCode?: WaitErrorCode,
      errorMessage?: string
    ): WaitDiagnostics => ({
      sessionId: options?.sessionId,
      workflowId: options?.workflowId,
      stepIndex: options?.stepIndex,
      condition: conditionName,
      targetDescription: options?.targetDescription,
      startTimestamp,
      elapsedMs: Date.now() - startTimestamp,
      timeoutMs,
      status,
      errorCode,
      error: errorMessage,
    });

    // Check cancellation before starting
    if (options?.signal?.aborted) {
      throw new WaitError(
        `Wait cancelled before starting: ${conditionName}`,
        'WAIT_CANCELLED',
        createDiagnostics('cancelled', 'WAIT_CANCELLED')
      );
    }

    // 1. Immediate evaluation check
    try {
      const immediateResult = await conditionFn();
      if (immediateResult) {
        return immediateResult;
      }
    } catch (err: unknown) {
      if (err instanceof WaitError) throw err;
      throw new WaitError(
        `Condition evaluation error: ${err instanceof Error ? err.message : String(err)}`,
        'ELEMENT_NOT_INTERACTABLE',
        createDiagnostics('error', 'ELEMENT_NOT_INTERACTABLE', String(err))
      );
    }

    // 2. Set up observer, polling interval, and timeout
    return new Promise<T>((resolve, reject) => {
      let isSettled = false;
      let observer: MutationObserver | null = null;
      let intervalTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        isSettled = true;
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (intervalTimer) {
          clearInterval(intervalTimer);
          intervalTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const checkCondition = async () => {
        if (isSettled) return;
        try {
          const res = await conditionFn();
          if (res && !isSettled) {
            cleanup();
            resolve(res);
          }
        } catch (err: unknown) {
          if (!isSettled) {
            cleanup();
            if (err instanceof WaitError) {
              reject(err);
            } else {
              reject(
                new WaitError(
                  `Condition evaluation error: ${err instanceof Error ? err.message : String(err)}`,
                  'ELEMENT_NOT_INTERACTABLE',
                  createDiagnostics('error', 'ELEMENT_NOT_INTERACTABLE', String(err))
                )
              );
            }
          }
        }
      };

      const onAbort = () => {
        if (isSettled) return;
        cleanup();
        reject(
          new WaitError(
            `Wait cancelled: ${conditionName}`,
            'WAIT_CANCELLED',
            createDiagnostics('cancelled', 'WAIT_CANCELLED')
          )
        );
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Timeout rejection
      timeoutTimer = setTimeout(() => {
        if (isSettled) return;
        cleanup();
        reject(
          new WaitError(
            `Wait timed out after ${timeoutMs}ms: ${conditionName}`,
            'WAIT_TIMEOUT',
            createDiagnostics('timeout', 'WAIT_TIMEOUT')
          )
        );
      }, timeoutMs);

      // DOM MutationObserver (runs in DOM environment)
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
        const root = document.documentElement || document.body;
        if (root) {
          observer = new MutationObserver(() => {
            void checkCondition();
          });
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        }
      }

      // Fallback bounded polling for style changes / animations / off-DOM conditions
      intervalTimer = setInterval(() => {
        void checkCondition();
      }, pollIntervalMs);
    });
  }

  /**
   * Checks whether an element is visible in the document.
   */
  public static isElementVisible(el: Element): boolean {
    if (!el || !el.isConnected) return false;
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return true;

    // Check inline/computed style
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      } catch {}
    }

    // Geometry check
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }

    if (el instanceof HTMLElement) {
      if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
      if (el.offsetParent !== null) return true;
    }

    // Fallback: If bounding box calculation is zero (e.g. in test env or inline element),
    // check if it's connected and not explicitly hidden
    return el.isConnected;
  }

  /**
   * Checks whether an element is enabled.
   */
  public static isElementEnabled(el: Element): boolean {
    if (!el || !el.isConnected) return false;

    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    if (
      el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      if (el.disabled) return false;
    }

    // Check if inside a disabled fieldset
    const fieldset = el.closest('fieldset[disabled]');
    if (fieldset) return false;

    return true;
  }

  /**
   * Checks whether an element is interactable for a specific action.
   */
  public static isElementInteractable(el: Element, action: ActionType): boolean {
    if (!this.isElementVisible(el)) return false;
    if (!this.isElementEnabled(el)) return false;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.pointerEvents === 'none') return false;
      } catch {}
    }

    if (action === 'input') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.readOnly) return false;
      }
    }

    // Pre-execution hit testing for click actions
    if (action === 'click' && el instanceof HTMLElement) {
      const hitTest = TargetResolver.checkHitTarget(el);
      if (hitTest.isObstructed) return false;
    }

    return true;
  }

  /**
   * Waits for a target element to appear and be uniquely resolved.
   * If an ambiguous target is detected, throws TARGET_AMBIGUOUS immediately without waiting for timeout.
   */
  public static async waitForElement(
    descriptor: TargetDescriptor,
    options?: WaitOptions
  ): Promise<Element> {
    const descText = descriptor.text ? `"${descriptor.text}"` : descriptor.selector || descriptor.id || 'target';
    const targetDescription = options?.targetDescription || descText;

    return this.waitForCondition<Element>(
      () => {
        const result: ResolutionResult = TargetResolver.resolve(descriptor);

        if (result.status === 'CONTEXT_MISMATCH') {
          throw new WaitError(
            `Context mismatch: ${result.reason || 'Invalid frame or document context'}`,
            'ELEMENT_NOT_INTERACTABLE',
            {
              sessionId: options?.sessionId,
              workflowId: options?.workflowId,
              stepIndex: options?.stepIndex,
              condition: 'waitForElement',
              targetDescription,
              startTimestamp: Date.now(),
              elapsedMs: 0,
              timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
              status: 'error',
              errorCode: 'ELEMENT_NOT_INTERACTABLE',
            }
          );
        }

        if (result.isAmbiguous || result.status === 'AMBIGUOUS') {
          throw new WaitError(
            `Ambiguous target: Multiple elements match descriptor (${result.candidatesCount || 2} tied candidates for ${targetDescription})`,
            'TARGET_AMBIGUOUS',
            {
              sessionId: options?.sessionId,
              workflowId: options?.workflowId,
              stepIndex: options?.stepIndex,
              condition: 'waitForElement',
              targetDescription,
              startTimestamp: Date.now(),
              elapsedMs: 0,
              timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
              status: 'error',
              errorCode: 'TARGET_AMBIGUOUS',
            }
          );
        }

        if (result.element && result.element.isConnected) {
          return result.element;
        }

        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
        message: options?.message || `waitForElement(${targetDescription})`,
        targetDescription,
      }
    );
  }

  /**
   * Waits for an element to become visible.
   */
  public static async waitForVisible(
    elementOrDescriptor: Element | TargetDescriptor,
    options?: WaitOptions
  ): Promise<HTMLElement> {
    const isDescriptor = !(elementOrDescriptor instanceof Element);
    const targetDesc = isDescriptor
      ? elementOrDescriptor.text || elementOrDescriptor.selector || 'target'
      : elementOrDescriptor.tagName.toLowerCase();

    return this.waitForCondition<HTMLElement>(
      async () => {
        let el: Element | null = null;
        if (isDescriptor) {
          const res = TargetResolver.resolve(elementOrDescriptor);
          el = res.element;
        } else {
          el = elementOrDescriptor;
        }

        if (el && this.isElementVisible(el)) {
          return el as HTMLElement;
        }
        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.visibleTimeoutMs,
        message: options?.message || `waitForVisible(${targetDesc})`,
      }
    );
  }

  /**
   * Waits for an element to become enabled.
   */
  public static async waitForEnabled(
    elementOrDescriptor: Element | TargetDescriptor,
    options?: WaitOptions
  ): Promise<HTMLElement> {
    const isDescriptor = !(elementOrDescriptor instanceof Element);
    const targetDesc = isDescriptor
      ? elementOrDescriptor.text || elementOrDescriptor.selector || 'target'
      : elementOrDescriptor.tagName.toLowerCase();

    return this.waitForCondition<HTMLElement>(
      async () => {
        let el: Element | null = null;
        if (isDescriptor) {
          const res = TargetResolver.resolve(elementOrDescriptor);
          el = res.element;
        } else {
          el = elementOrDescriptor;
        }

        if (el && this.isElementEnabled(el)) {
          return el as HTMLElement;
        }
        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.visibleTimeoutMs,
        message: options?.message || `waitForEnabled(${targetDesc})`,
      }
    );
  }

  /**
   * Comprehensive action precondition check:
   * Waits for the element to exist, become visible, enabled, and interactable for the action.
   */
  public static async waitForInteractable(
    elementOrDescriptor: Element | TargetDescriptor,
    action: ActionType,
    options?: WaitOptions
  ): Promise<HTMLElement> {
    const isDescriptor = !(elementOrDescriptor instanceof Element);
    const targetDesc = isDescriptor
      ? elementOrDescriptor.text || elementOrDescriptor.selector || 'target'
      : elementOrDescriptor.tagName.toLowerCase();

    return this.waitForCondition<HTMLElement>(
      async () => {
        let el: Element | null = null;
        if (isDescriptor) {
          const res = TargetResolver.resolve(elementOrDescriptor);
          if (res.status === 'CONTEXT_MISMATCH') {
            throw new WaitError(
              `Context mismatch for ${action} action: ${res.reason || 'Invalid frame or document context'}`,
              'ELEMENT_NOT_INTERACTABLE',
              {
                sessionId: options?.sessionId,
                workflowId: options?.workflowId,
                stepIndex: options?.stepIndex,
                condition: `waitForInteractable(${action})`,
                targetDescription: targetDesc,
                startTimestamp: Date.now(),
                elapsedMs: 0,
                timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
                status: 'error',
                errorCode: 'ELEMENT_NOT_INTERACTABLE',
              }
            );
          }
          if (res.isAmbiguous || res.status === 'AMBIGUOUS') {
            throw new WaitError(
              `Target is ambiguous for ${action} action: ${targetDesc}`,
              'TARGET_AMBIGUOUS',
              {
                sessionId: options?.sessionId,
                workflowId: options?.workflowId,
                stepIndex: options?.stepIndex,
                condition: `waitForInteractable(${action})`,
                targetDescription: targetDesc,
                startTimestamp: Date.now(),
                elapsedMs: 0,
                timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
                status: 'error',
                errorCode: 'TARGET_AMBIGUOUS',
              }
            );
          }
          el = res.element;
        } else {
          el = elementOrDescriptor;
        }

        if (el && el.isConnected && this.isElementInteractable(el, action)) {
          return el as HTMLElement;
        }
        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.elementResolveTimeoutMs,
        message: options?.message || `waitForInteractable(${action} on ${targetDesc})`,
        targetDescription: targetDesc,
      }
    );
  }

  /**
   * Waits for an element to disappear from the DOM or become hidden.
   */
  public static async waitForElementToDisappear(
    elementOrSelector: Element | string,
    options?: WaitOptions
  ): Promise<boolean> {
    const desc = typeof elementOrSelector === 'string' ? elementOrSelector : elementOrSelector.tagName;
    return this.waitForCondition<boolean>(
      () => {
        if (typeof elementOrSelector === 'string') {
          const el = document.querySelector(elementOrSelector);
          if (!el || !this.isElementVisible(el)) return true;
          return null;
        } else {
          if (!elementOrSelector.isConnected || !this.isElementVisible(elementOrSelector)) {
            return true;
          }
          return null;
        }
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.visibleTimeoutMs,
        message: options?.message || `waitForElementToDisappear(${desc})`,
      }
    );
  }

  /**
   * Waits for specific text content to appear within an element.
   */
  public static async waitForText(
    element: Element,
    expectedText: string,
    options?: WaitOptions
  ): Promise<boolean> {
    return this.waitForCondition<boolean>(
      () => {
        if (!element.isConnected) return null;
        const text = element.textContent || '';
        if (text.includes(expectedText)) return true;
        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.visibleTimeoutMs,
        message: options?.message || `waitForText("${expectedText}")`,
      }
    );
  }

  /**
   * Waits for window location URL to change from previous URL (SPA transitions).
   */
  public static async waitForUrlChange(
    previousUrl: string,
    options?: WaitOptions
  ): Promise<string> {
    return this.waitForCondition<string>(
      () => {
        if (typeof window === 'undefined') return null;
        const currentUrl = window.location.href;
        if (currentUrl !== previousUrl) return currentUrl;
        return null;
      },
      {
        ...options,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.navigationTimeoutMs,
        message: options?.message || `waitForUrlChange(from ${previousUrl})`,
      }
    );
  }

  /**
   * Waits for an element's bounding rect to stabilize after scrolling or animations.
   */
  public static async waitForStableElement(
    element: Element,
    options?: WaitOptions
  ): Promise<Element> {
    let lastRect: DOMRect | null = null;
    let stableCount = 0;

    return this.waitForCondition<Element>(
      () => {
        if (!element.isConnected) return null;
        const currentRect = element.getBoundingClientRect();

        if (
          lastRect &&
          Math.abs(currentRect.top - lastRect.top) < 1 &&
          Math.abs(currentRect.left - lastRect.left) < 1 &&
          Math.abs(currentRect.width - lastRect.width) < 1 &&
          Math.abs(currentRect.height - lastRect.height) < 1
        ) {
          stableCount++;
          if (stableCount >= 2) {
            return element;
          }
        } else {
          stableCount = 0;
        }

        lastRect = currentRect;
        return null;
      },
      {
        ...options,
        pollIntervalMs: 50,
        timeoutMs: options?.timeoutMs ?? this.timeoutConfig.settleDelayMs * 10,
        message: options?.message || 'waitForStableElement',
      }
    );
  }
}
