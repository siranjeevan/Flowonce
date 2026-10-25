import type {
  PostconditionDescriptor,
  EvaluationContext,
} from './verification-types';
import { WaitManager } from './WaitManager';
import { TargetResolver } from './TargetResolver';
import { sanitizeDiagnosticText } from './session/ReplaySessionStorage';

export interface PostconditionEvaluationOutcome {
  satisfied: boolean;
  actualState?: string;
  expectedCondition: string;
  elapsedMs: number;
  error?: string;
}

/**
 * Extracts the live value from an input or textarea element,
 * accessing the native prototype getter to support React, Vue, and Angular controlled inputs.
 */
function getLiveInputValue(el: HTMLElement): string {
  if (el instanceof HTMLSelectElement) {
    return el.value;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const directVal = (el as HTMLInputElement).value;
    if (directVal !== undefined && directVal !== '') {
      return directVal;
    }

    const proto = el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.get) {
      try {
        const protoVal = desc.get.call(el);
        if (protoVal !== undefined && protoVal !== '') {
          return protoVal;
        }
      } catch {}
    }
    return directVal || '';
  }
  if (el.isContentEditable) {
    return el.innerText;
  }
  return el.textContent || '';
}

/**
 * Normalizes URL strings by stripping trailing slashes and hash if needed.
 */
function normalizeUrl(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location?.origin : undefined);
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

/**
 * Evaluates supported postconditions using bounded, cancellation-aware checks.
 * Reuses WaitManager for MutationObserver and bounded fallback polling.
 */
export class PostconditionEvaluator {
  public static async evaluate(
    descriptor: PostconditionDescriptor,
    context?: EvaluationContext,
    timeoutMs: number = 3000
  ): Promise<PostconditionEvaluationOutcome> {
    const startTime = Date.now();
    const boundedTimeout = Math.min(Math.max(timeoutMs, 50), 30000);
    const expectedDesc = this.formatExpectedCondition(descriptor);

    let lastObservedState = 'Unknown';

    try {
      await WaitManager.waitForCondition(
        async () => {
          if (context?.signal?.aborted) return false;

          switch (descriptor.type) {
            case 'element_exists': {
              if (!descriptor.target) return true;
              const res = TargetResolver.resolve(descriptor.target);
              if (res.element) {
                lastObservedState = `Element <${res.element.tagName.toLowerCase()}> found in DOM`;
                return true;
              }
              lastObservedState = 'Element not found in DOM';
              return false;
            }

            case 'element_visible': {
              if (!descriptor.target) return true;
              const res = TargetResolver.resolve(descriptor.target);
              if (res.element && WaitManager.isElementVisible(res.element)) {
                lastObservedState = `Element <${res.element.tagName.toLowerCase()}> is visible`;
                return true;
              }
              lastObservedState = res.element
                ? `Element <${res.element.tagName.toLowerCase()}> found but hidden/zero-geometry`
                : 'Element not found in DOM';
              return false;
            }

            case 'element_absent': {
              if (!descriptor.target) return true;
              const res = TargetResolver.resolve(descriptor.target);
              if (!res.element || !WaitManager.isElementVisible(res.element)) {
                lastObservedState = !res.element ? 'Element is absent from DOM' : 'Element is hidden';
                return true;
              }
              lastObservedState = `Element <${res.element.tagName.toLowerCase()}> is still present and visible`;
              return false;
            }

            case 'element_enabled': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const disabled =
                (el as HTMLInputElement).disabled ||
                el.getAttribute('aria-disabled') === 'true' ||
                el.hasAttribute('disabled');
              lastObservedState = disabled ? 'Element is disabled' : 'Element is enabled';
              return !disabled;
            }

            case 'element_disabled': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const disabled =
                (el as HTMLInputElement).disabled ||
                el.getAttribute('aria-disabled') === 'true' ||
                el.hasAttribute('disabled');
              lastObservedState = disabled ? 'Element is disabled' : 'Element is enabled';
              return Boolean(disabled);
            }

            case 'text_equals': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const text = (el.textContent || '').trim();
              const expected = String(descriptor.expectedValue ?? '').trim();
              lastObservedState = `Text is "${text}"`;
              return text === expected;
            }

            case 'text_contains': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const text = el.textContent || '';
              const expected = String(descriptor.expectedValue ?? '');
              lastObservedState = `Text is "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`;
              return text.includes(expected);
            }

            case 'attribute_equals': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const attrName = descriptor.attributeName || '';
              const attrVal = el.getAttribute(attrName);
              const expected = String(descriptor.expectedValue ?? '');
              lastObservedState = `Attribute ${attrName}="${String(attrVal)}"`;
              return attrVal === expected;
            }

            case 'value_equals': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const currentVal = getLiveInputValue(el);
              const expected = String(descriptor.expectedValue ?? '');
              lastObservedState = `Value is "${currentVal}"`;
              return currentVal === expected;
            }

            case 'checked_equals': {
              const el = this.resolveTarget(descriptor, context);
              if (!el) {
                lastObservedState = 'Target element not found';
                return false;
              }
              const isChecked = (el as HTMLInputElement).checked;
              const expected = Boolean(descriptor.expectedValue);
              lastObservedState = `Checked state is ${isChecked}`;
              return Boolean(isChecked) === expected;
            }

            case 'url_equals': {
              const currentUrl = typeof window !== 'undefined' ? window.location?.href || '' : '';
              const expected = descriptor.urlPattern || String(descriptor.expectedValue ?? '');
              const matched = normalizeUrl(currentUrl) === normalizeUrl(expected);
              lastObservedState = `Current URL: ${currentUrl}`;
              return matched;
            }

            case 'url_matches': {
              const currentUrl = typeof window !== 'undefined' ? window.location?.href || '' : '';
              const pattern = descriptor.urlPattern || String(descriptor.expectedValue ?? '');
              let matched = false;
              try {
                const regex = new RegExp(pattern);
                matched = regex.test(currentUrl);
              } catch {
                matched = currentUrl.includes(pattern);
              }
              lastObservedState = `Current URL: ${currentUrl}`;
              return matched;
            }

            case 'url_changed': {
              const currentUrl = typeof window !== 'undefined' ? window.location?.href || '' : '';
              const initial = context?.initialUrl || '';
              const changed = normalizeUrl(currentUrl) !== normalizeUrl(initial);
              lastObservedState = changed
                ? `URL changed from ${initial} to ${currentUrl}`
                : `URL unchanged (${currentUrl})`;
              return changed;
            }

            case 'custom': {
              if (descriptor.target) {
                const res = TargetResolver.resolve(descriptor.target);
                if (res.element && WaitManager.isElementVisible(res.element)) {
                  lastObservedState = `Custom target element is visible`;
                  return true;
                }
                lastObservedState = 'Custom target element not visible';
                return false;
              }
              return true;
            }

            default:
              lastObservedState = `Unsupported postcondition type: ${String(descriptor.type)}`;
              return true;
          }
        },
        {
          timeoutMs: boundedTimeout,
          pollIntervalMs: 100,
          signal: context?.signal,
          sessionId: context?.sessionId,
          stepIndex: context?.stepIndex,
          message: expectedDesc,
        }
      );

      return {
        satisfied: true,
        actualState: sanitizeDiagnosticText(lastObservedState),
        expectedCondition: sanitizeDiagnosticText(expectedDesc) || expectedDesc,
        elapsedMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      const isCancelled =
        context?.signal?.aborted || (err as any)?.code === 'WAIT_CANCELLED';

      if (isCancelled) {
        throw err;
      }

      return {
        satisfied: false,
        actualState: sanitizeDiagnosticText(lastObservedState),
        expectedCondition: sanitizeDiagnosticText(expectedDesc) || expectedDesc,
        elapsedMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private static resolveTarget(
    descriptor: PostconditionDescriptor,
    context?: EvaluationContext
  ): HTMLElement | null {
    if (descriptor.target) {
      const res = TargetResolver.resolve(descriptor.target);
      return res.element;
    }
    return context?.targetElement || null;
  }

  private static formatExpectedCondition(descriptor: PostconditionDescriptor): string {
    switch (descriptor.type) {
      case 'element_exists':
        return `Element ${descriptor.target?.text ? `"${descriptor.target.text}"` : descriptor.target?.selector || 'target'} exists`;
      case 'element_visible':
        return `Element ${descriptor.target?.text ? `"${descriptor.target.text}"` : descriptor.target?.selector || 'target'} is visible`;
      case 'element_absent':
        return `Element ${descriptor.target?.text ? `"${descriptor.target.text}"` : descriptor.target?.selector || 'target'} disappears`;
      case 'element_enabled':
        return 'Element becomes enabled';
      case 'element_disabled':
        return 'Element becomes disabled';
      case 'text_equals':
        return `Text equals "${descriptor.expectedValue ?? ''}"`;
      case 'text_contains':
        return `Text contains "${descriptor.expectedValue ?? ''}"`;
      case 'attribute_equals':
        return `Attribute [${descriptor.attributeName}] equals "${descriptor.expectedValue ?? ''}"`;
      case 'value_equals':
        return `Input value equals "${descriptor.expectedValue ?? ''}"`;
      case 'checked_equals':
        return `Checkbox/radio checked is ${descriptor.expectedValue}`;
      case 'url_equals':
        return `URL equals "${descriptor.urlPattern || descriptor.expectedValue || ''}"`;
      case 'url_matches':
        return `URL matches pattern "${descriptor.urlPattern || descriptor.expectedValue || ''}"`;
      case 'url_changed':
        return 'URL changes from initial address';
      case 'custom':
        return descriptor.customDescription || 'Custom postcondition satisfied';
      default:
        return 'Postcondition satisfied';
    }
  }
}
