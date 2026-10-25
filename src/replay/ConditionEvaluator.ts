import type { StepConditionConfig, ConditionOperator } from '../shared/types/workflow';
import type { VariableContext } from './VariableContext';
import type { VerificationResult } from './verification-types';

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
    stepVerifications: Map<string, VerificationResult> | { id: string }[] = new Map(),
    steps?: { id: string }[]
  ): ConditionEvaluationResult {
    if (!config || !config.source || !config.operator) {
      throw new ConditionEvaluationError('Invalid condition configuration: missing source or operator');
    }

    // Support stepVerifications being passed or omitted when steps array is passed as 4th arg
    let verificationsMap = new Map<string, VerificationResult>();
    let stepList = steps;
    if (Array.isArray(stepVerifications)) {
      stepList = stepVerifications;
    } else if (stepVerifications instanceof Map) {
      verificationsMap = stepVerifications;
    }

    let actualValue: unknown;
    const operandName = config.name || (config as any).variableName;
    const expectedValue = config.value !== undefined ? config.value : (config as any).expectedValue;

    if (config.source === 'variable') {
      if (!operandName) {
        throw new ConditionEvaluationError('Variable condition requires a variable "name"');
      }
      actualValue = variableContext.get(operandName);
    } else if (config.source === 'verification') {
      // If a specific step is named, lookup that step's verification result, otherwise use lastVerification
      if (operandName && verificationsMap.has(operandName)) {
        const res = verificationsMap.get(operandName);
        actualValue = res ? res.status : 'SKIPPED';
      } else {
        actualValue = lastVerification ? lastVerification.status : 'SKIPPED';
      }
    } else {
      throw new ConditionEvaluationError(`Unsupported condition source: "${String(config.source)}"`);
    }

    const matched = this.evaluateOperator(config.operator, actualValue, expectedValue);

    // Determine target branch
    let targetBranch = matched
      ? (config.onTrue || 'next')
      : (config.onFalse || 'next');

    if (stepList && stepList.length > 0) {
      targetBranch = this.resolveBranchTarget(targetBranch, stepList);
    }

    const diagnosticInfo = `Condition [${config.source}:${operandName || 'last'}] (${config.operator} ${JSON.stringify(expectedValue)}) evaluated to ${matched ? 'TRUE' : 'FALSE'}. Actual: ${JSON.stringify(actualValue)}. Branch target: "${targetBranch}".`;

    return {
      matched,
      source: config.source,
      operandName,
      actualValue,
      expectedValue,
      operator: config.operator,
      targetBranch,
      diagnosticInfo,
    };
  }

  /**
   * Resolves branch target safely against workflow steps.
   */
  public static resolveBranchTarget(target: string | undefined, steps: { id: string }[] = []): string {
    if (!target || target === 'next' || target === 'end') return target || 'next';
    return steps.some(s => s.id === target) ? target : 'next';
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

        // If types match exactly
        if (typeof actual === typeof expected) {
          return actual === expected;
        }

        // Numeric comparison only when string is a non-empty numeric literal (e.g. "42" vs 42)
        if (typeof actual === 'number' && typeof expected === 'string') {
          if (expected.trim() === '') return false;
          const numB = Number(expected);
          return !isNaN(numB) && actual === numB;
        }
        if (typeof actual === 'string' && typeof expected === 'number') {
          if (actual.trim() === '') return false;
          const numA = Number(actual);
          return !isNaN(numA) && numA === expected;
        }

        // Boolean comparison only when string is explicit "true"/"false"
        if (typeof actual === 'boolean' && typeof expected === 'string') {
          if (expected === 'true') return actual === true;
          if (expected === 'false') return actual === false;
          return false;
        }
        if (typeof actual === 'string' && typeof expected === 'boolean') {
          if (actual === 'true') return expected === true;
          if (actual === 'false') return expected === false;
          return false;
        }

        return actual === expected;
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
