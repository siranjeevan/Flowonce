import type { StepConditionConfig, ConditionOperator } from '../shared/types/workflow';
import type { VariableContext } from './VariableContext';
import type { VerificationResult, VerificationStatus } from './verification-types';

export interface ConditionEvaluationResult {
  matched: boolean;
  source: 'variable' | 'verification';
  operandName?: string;
  actualValue: unknown;
  expectedValue?: unknown;
  operator: ConditionOperator;
  targetBranch: string; // 'next' | 'end' | step ID
  diagnosticInfo: string;
}

export class ConditionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionEvaluationError';
  }
}

/**
 * Pure, typed, non-eval condition evaluator for control-flow branching.
 * Safely evaluates variable values and structured action verification results.
 */
export class ConditionEvaluator {
  /**
   * Evaluates a StepConditionConfig against current variables and verification status.
   */
  public static evaluate(
    config: StepConditionConfig,
    variableContext: VariableContext,
    lastVerification?: VerificationResult | null,
    stepVerifications: Map<string, VerificationResult> = new Map()
  ): ConditionEvaluationResult {
    if (!config || !config.source || !config.operator) {
      throw new ConditionEvaluationError('Invalid condition configuration: missing source or operator');
    }

    let actualValue: unknown;
    let operandName = config.name;

    if (config.source === 'variable') {
      if (!operandName) {
        throw new ConditionEvaluationError('Variable condition requires a variable "name"');
      }
      actualValue = variableContext.get(operandName);
    } else if (config.source === 'verification') {
      // If a specific step is named, lookup that step's verification result, otherwise use lastVerification
      if (operandName && stepVerifications.has(operandName)) {
        const res = stepVerifications.get(operandName);
        actualValue = res ? res.status : 'SKIPPED';
      } else {
        actualValue = lastVerification ? lastVerification.status : 'SKIPPED';
      }
    } else {
      throw new ConditionEvaluationError(`Unsupported condition source: "${String(config.source)}"`);
    }

    const matched = this.evaluateOperator(config.operator, actualValue, config.value);

    // Determine target branch
    const targetBranch = matched
      ? (config.onTrue || 'next')
      : (config.onFalse || 'next');

    const diagnosticInfo = `Condition [${config.source}:${operandName || 'last'}] (${config.operator} ${JSON.stringify(config.value)}) evaluated to ${matched ? 'TRUE' : 'FALSE'}. Actual: ${JSON.stringify(actualValue)}. Branch target: "${targetBranch}".`;

    return {
      matched,
      source: config.source,
      operandName,
      actualValue,
      expectedValue: config.value,
      operator: config.operator,
      targetBranch,
      diagnosticInfo,
    };
  }

  /**
   * Evaluates an operator with strict type handling.
   * Never conflates missing variables with false, 0, or empty string.
   */
  public static evaluateOperator(
    operator: ConditionOperator,
    actual: unknown,
    expected: unknown
  ): boolean {
    switch (operator) {
      case 'exists': {
        // Defined and not null
        return actual !== undefined && actual !== null;
      }

      case 'is_empty': {
        if (actual === undefined || actual === null) return true;
        if (typeof actual === 'string') return actual.trim() === '';
        if (Array.isArray(actual)) return actual.length === 0;
        return false;
      }

      case 'equals': {
        if (actual === undefined) {
          return expected === undefined;
        }
        if (actual === null) {
          return expected === null;
        }
        // Strict number comparison
        if (typeof actual === 'number' || typeof expected === 'number') {
          const numA = Number(actual);
          const numB = Number(expected);
          if (!isNaN(numA) && !isNaN(numB)) {
            return numA === numB;
          }
        }
        // Strict boolean comparison
        if (typeof actual === 'boolean' || typeof expected === 'boolean') {
          return Boolean(actual) === Boolean(expected);
        }
        return String(actual) === String(expected);
      }

      case 'not_equals': {
        return !this.evaluateOperator('equals', actual, expected);
      }

      case 'contains': {
        if (actual === undefined || actual === null || expected === undefined || expected === null) {
          return false;
        }
        if (typeof actual === 'string') {
          return actual.includes(String(expected));
        }
        if (Array.isArray(actual)) {
          return actual.includes(expected);
        }
        return false;
      }

      case 'starts_with': {
        if (actual === undefined || actual === null || expected === undefined || expected === null) {
          return false;
        }
        return String(actual).startsWith(String(expected));
      }

      case 'ends_with': {
        if (actual === undefined || actual === null || expected === undefined || expected === null) {
          return false;
        }
        return String(actual).endsWith(String(expected));
      }

      case 'greater_than': {
        const numA = this.toNumber(actual);
        const numB = this.toNumber(expected);
        if (numA === null || numB === null) return false;
        return numA > numB;
      }

      case 'greater_than_or_equal': {
        const numA = this.toNumber(actual);
        const numB = this.toNumber(expected);
        if (numA === null || numB === null) return false;
        return numA >= numB;
      }

      case 'less_than': {
        const numA = this.toNumber(actual);
        const numB = this.toNumber(expected);
        if (numA === null || numB === null) return false;
        return numA < numB;
      }

      case 'less_than_or_equal': {
        const numA = this.toNumber(actual);
        const numB = this.toNumber(expected);
        if (numA === null || numB === null) return false;
        return numA <= numB;
      }

      default:
        throw new ConditionEvaluationError(`Unsupported condition operator: "${String(operator)}"`);
    }
  }

  private static toNumber(val: unknown): number | null {
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? null : num;
  }
}
