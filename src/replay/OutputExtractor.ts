import type { OutputExtractionConfig, ExtractionType } from '../shared/types/workflow';
import { WaitManager } from './WaitManager';

export interface ExtractionResult {
  success: boolean;
  extractionId: string;
  variableName: string;
  value: string | number | boolean | null;
  extractionType: ExtractionType;
  error?: string;
  diagnosticInfo?: string;
}

export interface ExtractionOptions {
  signal?: AbortSignal;
  sessionId?: string;
  workflowId?: string;
  stepIndex?: number;
  isSensitive?: boolean;
}

/**
 * Reusable DOM output extraction component.
 * Extracts text, attributes, form controls, and browser metadata
 * into named runtime variables with target resolution, waiting,
 * controlled-component compatibility, and sensitive-data sanitization.
 */
export class OutputExtractor {
  /**
   * Executes a configured DOM extraction.
   */
  public static async extract(
    config: OutputExtractionConfig,
    options?: ExtractionOptions
  ): Promise<ExtractionResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(Math.max(config.timeoutMs || 5000, 100), 30000);
    const type: ExtractionType = config.type || (config as any).extractionType;
    const extractionId: string = config.id || `ext_${Date.now()}`;

    // 1. Browser-level extractions that do not require an element
    if (type === 'document_title') {
      const title = typeof document !== 'undefined' ? document.title : '';
      return {
        success: true,
        extractionId,
        variableName: config.variableName,
        value: title,
        extractionType: type,
        diagnosticInfo: `Extracted document title: "${options?.isSensitive ? '••••••••' : title}"`,
      };
    }

    if (type === 'current_url') {
      const url = typeof window !== 'undefined' ? window.location.href : '';
      return {
        success: true,
        extractionId,
        variableName: config.variableName,
        value: url,
        extractionType: type,
        diagnosticInfo: `Extracted current URL: "${options?.isSensitive ? '••••••••' : url}"`,
      };
    }

    // 2. DOM-based extractions require target descriptor
    if (!config.target) {
      return {
        success: false,
        extractionId,
        variableName: config.variableName,
        value: null,
        extractionType: type,
        error: `Extraction "${extractionId}" requires a target descriptor for type "${type}"`,
        diagnosticInfo: 'Target descriptor missing in extraction config',
      };
    }

    // 3. Wait for element to appear and be ready
    let el: HTMLElement | null = null;
    try {
      el = (await WaitManager.waitForElement(config.target, {
        timeoutMs: timeoutMs,
        signal: options?.signal,
        sessionId: options?.sessionId,
        workflowId: options?.workflowId,
        stepIndex: options?.stepIndex,
      })) as HTMLElement;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Timeout waiting for extraction target';
      return {
        success: false,
        extractionId,
        variableName: config.variableName,
        value: null,
        extractionType: type,
        error: errorMsg,
        diagnosticInfo: `Target element not found within ${timeoutMs}ms for variable "${config.variableName}"`,
      };
    }

    if (!el) {
      return {
        success: false,
        extractionId,
        variableName: config.variableName,
        value: null,
        extractionType: type,
        error: `Target element for extraction "${extractionId}" was null`,
        diagnosticInfo: 'Element resolution returned null',
      };
    }

    // 4. Extract value based on type
    try {
      const extractedValue = this.extractValueFromElement(el, type, config.attributeName);
      const displayVal = options?.isSensitive ? '••••••••' : String(extractedValue);

      return {
        success: true,
        extractionId,
        variableName: config.variableName,
        value: extractedValue,
        extractionType: type,
        diagnosticInfo: `Successfully extracted ${type} = "${displayVal}" in ${Date.now() - startedAt}ms`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Extraction error';
      return {
        success: false,
        extractionId,
        variableName: config.variableName,
        value: null,
        extractionType: type,
        error: errorMsg,
        diagnosticInfo: `Failed to extract ${type} from element: ${errorMsg}`,
      };
    }
  }

  /**
   * Reads raw data from DOM element according to extraction type.
   * Handles React/Vue controlled component overrides for input_value.
   */
  public static extractValueFromElement(
    el: HTMLElement,
    type: ExtractionType,
    attributeName?: string
  ): string | number | boolean | null {
    switch (type) {
      case 'text_content':
        return el.textContent !== null ? el.textContent.trim() : '';

      case 'inner_text':
        return el.innerText !== undefined ? el.innerText.trim() : (el.textContent?.trim() ?? '');

      case 'attribute': {
        if (!attributeName) {
          throw new Error('attributeName is required for attribute extraction');
        }
        return el.getAttribute(attributeName) ?? '';
      }

      case 'input_value':
        return this.getLiveInputValue(el);

      case 'checked_state': {
        if ('checked' in el) {
          return Boolean((el as HTMLInputElement).checked);
        }
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked !== null) {
          return ariaChecked === 'true';
        }
        return false;
      }

      case 'selected_value': {
        if (el instanceof HTMLSelectElement) {
          return el.value;
        }
        if ('value' in el) {
          return String((el as HTMLInputElement).value);
        }
        return el.getAttribute('data-value') || el.textContent?.trim() || '';
      }

      case 'href': {
        if (el instanceof HTMLAnchorElement || 'href' in el) {
          return (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
        }
        return el.getAttribute('href') || '';
      }

      case 'src': {
        if (el instanceof HTMLImageElement || 'src' in el) {
          return (el as HTMLImageElement).src || el.getAttribute('src') || '';
        }
        return el.getAttribute('src') || '';
      }

      default:
        throw new Error(`Unsupported extraction type: "${type}"`);
    }
  }

  /**
   * Safely inspects input, textarea, and select controls,
   * querying both prototype getters and instance properties to handle
   * controlled framework inputs (React 18/19, Vue).
   */
  private static getLiveInputValue(el: HTMLElement): string {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      try {
        let proto = Object.getPrototypeOf(el);
        while (proto && proto !== Object.prototype) {
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.get) {
            const protoVal = desc.get.call(el);
            if (protoVal !== undefined && protoVal !== null) {
              return String(protoVal);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }
      } catch {
        // Fall back to direct instance value
      }
      return el.value ?? '';
    }

    if (el.isContentEditable) {
      return el.innerText?.trim() ?? el.textContent?.trim() ?? '';
    }

    return el.getAttribute('value') ?? '';
  }
}
