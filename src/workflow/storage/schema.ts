import type {
  Workflow,
  WorkflowStep,
  WorkflowVariable,
  TargetDescriptor,
  Position,
  ActionType,
} from '../../shared/types/workflow';
import { CURRENT_SCHEMA_VERSION } from './storage-keys';

export const VALID_ACTION_TYPES: ReadonlySet<ActionType> = new Set([
  'click',
  'input',
  'keydown',
  'keypress',
  'scroll',
  'select',
  'checkbox',
  'radio',
  'drag',
  'navigate',
  'video_interaction',
  'video',
  'wait',
  'copy',
  'paste',
  'extract',
  'condition',
]);

export const VALID_EXTRACTION_TYPES: ReadonlySet<string> = new Set([
  'text_content',
  'inner_text',
  'attribute',
  'input_value',
  'checked_state',
  'selected_value',
  'href',
  'src',
  'document_title',
  'current_url',
]);

export const VALID_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not_equals',
  'exists',
  'is_empty',
  'contains',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'starts_with',
  'ends_with',
]);

export const VALID_VARIABLE_DATA_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'any',
]);

export interface ValidationError {
  field: string;
  message: string;
  workflowId?: string;
  stepIndex?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validates a Position object if present
 */
export function validatePosition(
  pos: unknown,
  stepIndex?: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (pos === null || pos === undefined) return errors;
  if (typeof pos !== 'object') {
    errors.push({
      field: 'position',
      message: 'Position must be an object',
      workflowId,
      stepIndex,
    });
    return errors;
  }

  const p = pos as Record<string, unknown>;
  const coordFields = ['clientX', 'clientY', 'relativeX', 'relativeY', 'scrollX', 'scrollY'] as const;
  for (const field of coordFields) {
    if (field in p && p[field] !== undefined && typeof p[field] !== 'number') {
      errors.push({
        field: `position.${field}`,
        message: `Position coordinate '${field}' must be a number`,
        workflowId,
        stepIndex,
      });
    }
  }
  return errors;
}

/**
 * Validates a TargetDescriptor if present
 */
export function validateTargetDescriptor(
  target: unknown,
  stepIndex?: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (target === null || target === undefined) return errors;
  if (typeof target !== 'object') {
    errors.push({
      field: 'target',
      message: 'Target descriptor must be an object',
      workflowId,
      stepIndex,
    });
    return errors;
  }

  const t = target as Record<string, unknown>;
  const stringOrNullFields = [
    'id',
    'testId',
    'name',
    'role',
    'ariaLabel',
    'text',
    'placeholder',
    'href',
    'src',
    'tag',
    'selector',
    'element',
    'containerText',
    'frameSelector',
    'contextSnippet',
  ] as const;

  for (const field of stringOrNullFields) {
    if (field in t && t[field] !== undefined && t[field] !== null && typeof t[field] !== 'string') {
      errors.push({
        field: `target.${field}`,
        message: `Target descriptor '${field}' must be a string or null`,
        workflowId,
        stepIndex,
      });
    }
  }

  if (t.relativePosition !== undefined && t.relativePosition !== null) {
    errors.push(...validatePosition(t.relativePosition, stepIndex, workflowId));
  }

  return errors;
}

/**
 * Validates a single WorkflowStep
 */
export function validateWorkflowStep(
  step: unknown,
  index: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!step || typeof step !== 'object') {
    errors.push({
      field: `steps[${index}]`,
      message: `Step at index ${index} must be an object`,
      workflowId,
      stepIndex: index,
    });
    return errors;
  }

  const s = step as Record<string, unknown>;

  // id validation
  if (!s.id || typeof s.id !== 'string') {
    errors.push({
      field: `steps[${index}].id`,
      message: `Step at index ${index} requires a non-empty string 'id'`,
      workflowId,
      stepIndex: index,
    });
  }

  // type validation
  if (!s.type || typeof s.type !== 'string' || !VALID_ACTION_TYPES.has(s.type as ActionType)) {
    errors.push({
      field: `steps[${index}].type`,
      message: `Step at index ${index} has invalid action type: '${String(s.type)}'`,
      workflowId,
      stepIndex: index,
    });
  }

  // timestamp validation
  if (typeof s.timestamp !== 'number' || isNaN(s.timestamp) || s.timestamp < 0) {
    errors.push({
      field: `steps[${index}].timestamp`,
      message: `Step at index ${index} must have a valid non-negative numeric timestamp`,
      workflowId,
      stepIndex: index,
    });
  }

  // url validation
  if (typeof s.url !== 'string') {
    errors.push({
      field: `steps[${index}].url`,
      message: `Step at index ${index} requires a string 'url'`,
      workflowId,
      stepIndex: index,
    });
  }

  // sequence validation
  if (typeof s.sequence !== 'number' || isNaN(s.sequence) || s.sequence < 0) {
    errors.push({
      field: `steps[${index}].sequence`,
      message: `Step at index ${index} must have a valid non-negative sequence number`,
      workflowId,
      stepIndex: index,
    });
  }

  // target validation
  if (s.target !== undefined && s.target !== null) {
    errors.push(...validateTargetDescriptor(s.target, index, workflowId));
  }

  // position validation
  if (s.position !== undefined && s.position !== null) {
    errors.push(...validatePosition(s.position, index, workflowId));
  }

  // optional string / boolean fields
  if (s.value !== undefined && s.value !== null && typeof s.value !== 'string') {
    errors.push({
      field: `steps[${index}].value`,
      message: `Step at index ${index} 'value' must be a string, null, or undefined`,
      workflowId,
      stepIndex: index,
    });
  }

  if (s.sensitive !== undefined && typeof s.sensitive !== 'boolean') {
    errors.push({
      field: `steps[${index}].sensitive`,
      message: `Step at index ${index} 'sensitive' must be a boolean`,
      workflowId,
      stepIndex: index,
    });
  }

  if (s.key !== undefined && typeof s.key !== 'string') {
    errors.push({
      field: `steps[${index}].key`,
      message: `Step at index ${index} 'key' must be a string`,
      workflowId,
      stepIndex: index,
    });
  }

  if (s.verification !== undefined && s.verification !== null) {
    errors.push(...validateStepVerificationConfig(s.verification, index, workflowId));
  }

  if (s.extraction !== undefined && s.extraction !== null) {
    errors.push(...validateExtractionConfig(s.extraction, index, workflowId));
  } else if (s.type === 'extract') {
    errors.push({
      field: `steps[${index}].extraction`,
      message: `Step at index ${index} has type 'extract' but is missing 'extraction' configuration`,
      workflowId,
      stepIndex: index,
    });
  }

  if (s.condition !== undefined && s.condition !== null) {
    errors.push(...validateStepConditionConfig(s.condition, index, workflowId));
  } else if (s.type === 'condition') {
    errors.push({
      field: `steps[${index}].condition`,
      message: `Step at index ${index} has type 'condition' but is missing 'condition' configuration`,
      workflowId,
      stepIndex: index,
    });
  }

  return errors;
}

export function validateExtractionConfig(
  config: unknown,
  stepIndex?: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (config === undefined || config === null) return errors;

  if (typeof config !== 'object') {
    errors.push({
      field: `steps[${stepIndex}].extraction`,
      message: 'Extraction config must be an object',
      workflowId,
      stepIndex,
    });
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (!c.id || typeof c.id !== 'string' || !c.id.trim()) {
    errors.push({
      field: `steps[${stepIndex}].extraction.id`,
      message: 'Extraction requires a non-empty string "id"',
      workflowId,
      stepIndex,
    });
  }

  if (!c.type || typeof c.type !== 'string' || !VALID_EXTRACTION_TYPES.has(c.type)) {
    errors.push({
      field: `steps[${stepIndex}].extraction.type`,
      message: `Invalid extraction type: '${String(c.type)}'`,
      workflowId,
      stepIndex,
    });
  }

  if (!c.variableName || typeof c.variableName !== 'string' || !c.variableName.trim()) {
    errors.push({
      field: `steps[${stepIndex}].extraction.variableName`,
      message: 'Extraction requires a non-empty destination "variableName"',
      workflowId,
      stepIndex,
    });
  }

  if (c.type === 'attribute') {
    if (!c.attributeName || typeof c.attributeName !== 'string' || !c.attributeName.trim()) {
      errors.push({
        field: `steps[${stepIndex}].extraction.attributeName`,
        message: 'Extraction of type "attribute" requires an "attributeName"',
        workflowId,
        stepIndex,
      });
    }
  }

  if (c.timeoutMs !== undefined) {
    if (typeof c.timeoutMs !== 'number' || isNaN(c.timeoutMs) || c.timeoutMs < 50 || c.timeoutMs > 60000) {
      errors.push({
        field: `steps[${stepIndex}].extraction.timeoutMs`,
        message: '"timeoutMs" must be a number between 50 and 60000',
        workflowId,
        stepIndex,
      });
    }
  }

  if (c.onFailure !== undefined && c.onFailure !== 'fail' && c.onFailure !== 'pause' && c.onFailure !== 'continue') {
    errors.push({
      field: `steps[${stepIndex}].extraction.onFailure`,
      message: '"onFailure" must be one of "fail", "pause", or "continue"',
      workflowId,
      stepIndex,
    });
  }

  if (c.target !== undefined && c.target !== null) {
    errors.push(...validateTargetDescriptor(c.target, stepIndex, workflowId));
  }

  return errors;
}

export function validateStepConditionConfig(
  config: unknown,
  stepIndex?: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (config === undefined || config === null) return errors;

  if (typeof config !== 'object') {
    errors.push({
      field: `steps[${stepIndex}].condition`,
      message: 'Condition config must be an object',
      workflowId,
      stepIndex,
    });
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (c.source !== 'variable' && c.source !== 'verification') {
    errors.push({
      field: `steps[${stepIndex}].condition.source`,
      message: 'Condition source must be "variable" or "verification"',
      workflowId,
      stepIndex,
    });
  }

  if (c.source === 'variable' && (!c.name || typeof c.name !== 'string' || !c.name.trim())) {
    errors.push({
      field: `steps[${stepIndex}].condition.name`,
      message: 'Variable condition requires a non-empty variable "name"',
      workflowId,
      stepIndex,
    });
  }

  if (!c.operator || typeof c.operator !== 'string' || !VALID_CONDITION_OPERATORS.has(c.operator)) {
    errors.push({
      field: `steps[${stepIndex}].condition.operator`,
      message: `Invalid condition operator: '${String(c.operator)}'`,
      workflowId,
      stepIndex,
    });
  }

  if (c.onTrue !== undefined && typeof c.onTrue !== 'string') {
    errors.push({
      field: `steps[${stepIndex}].condition.onTrue`,
      message: '"onTrue" target must be a string step ID or "next"/"end"',
      workflowId,
      stepIndex,
    });
  }

  if (c.onFalse !== undefined && typeof c.onFalse !== 'string') {
    errors.push({
      field: `steps[${stepIndex}].condition.onFalse`,
      message: '"onFalse" target must be a string step ID or "next"/"end"',
      workflowId,
      stepIndex,
    });
  }

  return errors;
}

export const VALID_VERIFICATION_STRATEGIES: ReadonlySet<string> = new Set([
  'auto',
  'none',
  'element_visible',
  'element_absent',
  'value_match',
  'checked_state',
  'url_match',
  'url_changed',
  'text_match',
  'attribute_match',
  'custom',
]);

export const VALID_POSTCONDITION_TYPES: ReadonlySet<string> = new Set([
  'element_exists',
  'element_visible',
  'element_absent',
  'element_enabled',
  'element_disabled',
  'text_equals',
  'text_contains',
  'attribute_equals',
  'value_equals',
  'checked_equals',
  'url_equals',
  'url_matches',
  'url_changed',
  'custom',
]);

export function validateStepVerificationConfig(
  config: unknown,
  stepIndex?: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (config === undefined || config === null) return errors;

  if (typeof config !== 'object') {
    errors.push({
      field: `steps[${stepIndex}].verification`,
      message: 'Verification config must be an object',
      workflowId,
      stepIndex,
    });
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (typeof c.enabled !== 'boolean') {
    errors.push({
      field: `steps[${stepIndex}].verification.enabled`,
      message: "'enabled' must be a boolean",
      workflowId,
      stepIndex,
    });
  }

  if (c.strategy !== undefined && (typeof c.strategy !== 'string' || !VALID_VERIFICATION_STRATEGIES.has(c.strategy))) {
    errors.push({
      field: `steps[${stepIndex}].verification.strategy`,
      message: `Invalid verification strategy: '${String(c.strategy)}'`,
      workflowId,
      stepIndex,
    });
  }

  if (c.timeoutMs !== undefined) {
    if (typeof c.timeoutMs !== 'number' || isNaN(c.timeoutMs) || c.timeoutMs < 50 || c.timeoutMs > 60000) {
      errors.push({
        field: `steps[${stepIndex}].verification.timeoutMs`,
        message: "'timeoutMs' must be a number between 50 and 60000",
        workflowId,
        stepIndex,
      });
    }
  }

  if (c.pauseOnFailure !== undefined && typeof c.pauseOnFailure !== 'boolean') {
    errors.push({
      field: `steps[${stepIndex}].verification.pauseOnFailure`,
      message: "'pauseOnFailure' must be a boolean",
      workflowId,
      stepIndex,
    });
  }

  if (c.requireUserRecoveryOnUncertain !== undefined && typeof c.requireUserRecoveryOnUncertain !== 'boolean') {
    errors.push({
      field: `steps[${stepIndex}].verification.requireUserRecoveryOnUncertain`,
      message: "'requireUserRecoveryOnUncertain' must be a boolean",
      workflowId,
      stepIndex,
    });
  }

  if (c.postcondition !== undefined && c.postcondition !== null) {
    if (typeof c.postcondition !== 'object') {
      errors.push({
        field: `steps[${stepIndex}].verification.postcondition`,
        message: 'Postcondition must be an object',
        workflowId,
        stepIndex,
      });
    } else {
      const p = c.postcondition as Record<string, unknown>;
      if (!p.type || typeof p.type !== 'string' || !VALID_POSTCONDITION_TYPES.has(p.type)) {
        errors.push({
          field: `steps[${stepIndex}].verification.postcondition.type`,
          message: `Invalid postcondition type: '${String(p.type)}'`,
          workflowId,
          stepIndex,
        });
      }
      if (p.target !== undefined && p.target !== null) {
        errors.push(...validateTargetDescriptor(p.target, stepIndex, workflowId));
      }
    }
  }

  return errors;
}

/**
 * Validates a WorkflowVariable
 */
export function validateVariable(
  variable: unknown,
  index: number,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!variable || typeof variable !== 'object') {
    errors.push({
      field: `variables[${index}]`,
      message: `Variable at index ${index} must be an object`,
      workflowId,
    });
    return errors;
  }

  const v = variable as Record<string, unknown>;
  if (!v.name || typeof v.name !== 'string' || !v.name.trim()) {
    errors.push({
      field: `variables[${index}].name`,
      message: `Variable at index ${index} requires a non-empty name string`,
      workflowId,
    });
  }

  if (typeof v.required !== 'boolean') {
    errors.push({
      field: `variables[${index}].required`,
      message: `Variable at index ${index} requires a boolean 'required' flag`,
      workflowId,
    });
  }

  if (v.type !== undefined && (typeof v.type !== 'string' || !VALID_VARIABLE_DATA_TYPES.has(v.type))) {
    errors.push({
      field: `variables[${index}].type`,
      message: `Variable at index ${index} has invalid type '${String(v.type)}'`,
      workflowId,
    });
  }

  if (v.sensitive !== undefined && typeof v.sensitive !== 'boolean') {
    errors.push({
      field: `variables[${index}].sensitive`,
      message: `Variable at index ${index} 'sensitive' flag must be a boolean`,
      workflowId,
    });
  }

  if (v.description !== undefined && typeof v.description !== 'string') {
    errors.push({
      field: `variables[${index}].description`,
      message: `Variable at index ${index} 'description' must be a string`,
      workflowId,
    });
  }

  return errors;
}

export function validateWorkflowDatasetConfig(
  config: unknown,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (config === undefined || config === null) return errors;

  if (typeof config !== 'object') {
    errors.push({
      field: 'datasetConfig',
      message: 'Workflow datasetConfig must be an object',
      workflowId,
    });
    return errors;
  }

  const c = config as Record<string, unknown>;
  if (c.defaultSourceType !== undefined && c.defaultSourceType !== 'csv' && c.defaultSourceType !== 'json') {
    errors.push({
      field: 'datasetConfig.defaultSourceType',
      message: 'defaultSourceType must be "csv" or "json"',
      workflowId,
    });
  }

  if (c.maxRows !== undefined) {
    if (typeof c.maxRows !== 'number' || isNaN(c.maxRows) || c.maxRows < 1 || c.maxRows > 50000) {
      errors.push({
        field: 'datasetConfig.maxRows',
        message: 'maxRows must be a positive integer up to 50000',
        workflowId,
      });
    }
  }

  if (c.requiredColumns !== undefined) {
    if (!Array.isArray(c.requiredColumns)) {
      errors.push({
        field: 'datasetConfig.requiredColumns',
        message: 'requiredColumns must be an array of column names',
        workflowId,
      });
    } else {
      for (let i = 0; i < c.requiredColumns.length; i++) {
        if (typeof c.requiredColumns[i] !== 'string' || !c.requiredColumns[i].trim()) {
          errors.push({
            field: `datasetConfig.requiredColumns[${i}]`,
            message: 'Column name must be a non-empty string',
            workflowId,
          });
        }
      }
    }
  }

  return errors;
}

export function validateWorkflowSettings(
  settings: unknown,
  workflowId?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (settings === undefined || settings === null) return errors;

  if (typeof settings !== 'object') {
    errors.push({
      field: 'settings',
      message: 'Workflow settings must be an object',
      workflowId,
    });
    return errors;
  }

  const s = settings as Record<string, unknown>;
  if (s.maxStepBudget !== undefined) {
    if (typeof s.maxStepBudget !== 'number' || isNaN(s.maxStepBudget) || s.maxStepBudget < 1 || s.maxStepBudget > 10000) {
      errors.push({
        field: 'settings.maxStepBudget',
        message: 'maxStepBudget must be a positive number between 1 and 10000',
        workflowId,
      });
    }
  }

  if (s.defaultTimeoutMs !== undefined) {
    if (typeof s.defaultTimeoutMs !== 'number' || isNaN(s.defaultTimeoutMs) || s.defaultTimeoutMs < 100 || s.defaultTimeoutMs > 120000) {
      errors.push({
        field: 'settings.defaultTimeoutMs',
        message: 'defaultTimeoutMs must be a number between 100 and 120000',
        workflowId,
      });
    }
  }

  return errors;
}

/**
 * Validates timestamp strings (e.g., ISO date or parseable date string)
 */
function isValidDateString(val: unknown): boolean {
  if (typeof val !== 'string' || !val.trim()) return false;
  const parsed = Date.parse(val);
  return !isNaN(parsed);
}

/**
 * Validates a Workflow object at runtime.
 */
export function validateWorkflow(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      errors: [{ field: 'workflow', message: 'Workflow must be a non-null object' }],
    };
  }

  const wf = data as Record<string, unknown>;
  const workflowId = typeof wf.id === 'string' ? wf.id : undefined;

  // id validation
  if (!wf.id || typeof wf.id !== 'string' || !wf.id.trim()) {
    errors.push({
      field: 'id',
      message: 'Workflow must have a non-empty string id',
      workflowId,
    });
  }

  // name validation
  if (!wf.name || typeof wf.name !== 'string' || !wf.name.trim()) {
    errors.push({
      field: 'name',
      message: 'Workflow must have a non-empty string name',
      workflowId,
    });
  }

  // schemaVersion validation
  if (wf.schemaVersion !== undefined) {
    if (
      typeof wf.schemaVersion !== 'number' ||
      isNaN(wf.schemaVersion) ||
      wf.schemaVersion < 1 ||
      wf.schemaVersion > CURRENT_SCHEMA_VERSION
    ) {
      errors.push({
        field: 'schemaVersion',
        message: `Unsupported schema version: ${String(wf.schemaVersion)}. Supported versions: 1 to ${CURRENT_SCHEMA_VERSION}`,
        workflowId,
      });
    }
  }

  // steps validation
  const stepIds = new Set<string>();
  if (!Array.isArray(wf.steps)) {
    errors.push({
      field: 'steps',
      message: 'Workflow steps must be an array',
      workflowId,
    });
  } else {
    for (let i = 0; i < wf.steps.length; i++) {
      const stepObj = wf.steps[i];
      if (stepObj && typeof stepObj === 'object' && typeof (stepObj as any).id === 'string') {
        stepIds.add((stepObj as any).id);
      }
      errors.push(...validateWorkflowStep(stepObj, i, workflowId));
    }

    // Branch target resolution validation
    for (let i = 0; i < wf.steps.length; i++) {
      const stepObj = wf.steps[i];
      if (stepObj && typeof stepObj === 'object' && (stepObj as any).condition) {
        const cond = (stepObj as any).condition;
        if (cond.onTrue && cond.onTrue !== 'next' && cond.onTrue !== 'end' && !stepIds.has(cond.onTrue)) {
          errors.push({
            field: `steps[${i}].condition.onTrue`,
            message: `Branch target 'onTrue' references non-existent step ID "${cond.onTrue}"`,
            workflowId,
            stepIndex: i,
          });
        }
        if (cond.onFalse && cond.onFalse !== 'next' && cond.onFalse !== 'end' && !stepIds.has(cond.onFalse)) {
          errors.push({
            field: `steps[${i}].condition.onFalse`,
            message: `Branch target 'onFalse' references non-existent step ID "${cond.onFalse}"`,
            workflowId,
            stepIndex: i,
          });
        }
      }
    }
  }

  // variables validation
  if (wf.variables !== undefined) {
    if (!Array.isArray(wf.variables)) {
      errors.push({
        field: 'variables',
        message: 'Workflow variables must be an array if provided',
        workflowId,
      });
    } else {
      for (let i = 0; i < wf.variables.length; i++) {
        errors.push(...validateVariable(wf.variables[i], i, workflowId));
      }
    }
  }

  // datasetConfig validation
  if (wf.datasetConfig !== undefined) {
    errors.push(...validateWorkflowDatasetConfig(wf.datasetConfig, workflowId));
  }

  // settings validation
  if (wf.settings !== undefined) {
    errors.push(...validateWorkflowSettings(wf.settings, workflowId));
  }

  // createdAt and updatedAt
  if (wf.createdAt !== undefined && !isValidDateString(wf.createdAt) && typeof wf.createdAt !== 'number') {
    errors.push({
      field: 'createdAt',
      message: 'createdAt must be a valid ISO date string or numeric timestamp',
      workflowId,
    });
  }

  if (wf.updatedAt !== undefined && !isValidDateString(wf.updatedAt) && typeof wf.updatedAt !== 'number') {
    errors.push({
      field: 'updatedAt',
      message: 'updatedAt must be a valid ISO date string or numeric timestamp',
      workflowId,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Type guard for Workflow
 */
export function isWorkflow(data: unknown): data is Workflow {
  return validateWorkflow(data).valid;
}

/**
 * Asserts that data conforms to Workflow schema, throwing structured error if not.
 */
export function assertValidWorkflow(data: unknown): asserts data is Workflow {
  const result = validateWorkflow(data);
  if (!result.valid) {
    const errorDetails = result.errors.map((e) => `[${e.field}] ${e.message}`).join('; ');
    throw new Error(`Invalid workflow schema: ${errorDetails}`);
  }
}

/**
 * Normalizes legacy or partial workflow records into canonical Workflow format.
 * Automatically converts legacy fields (schemaVersion 1 -> 2, numeric timestamps to ISO strings,
 * missing default arrays).
 */
export function normalizeWorkflow(raw: unknown): Workflow {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Cannot normalize non-object workflow');
  }

  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' && r.id.trim()
    ? r.id.trim()
    : `WF_${Date.now().toString(36).toUpperCase()}`;

  const name = typeof r.name === 'string' && r.name.trim()
    ? r.name.trim()
    : `Workflow ${new Date().toLocaleString()}`;

  const description = typeof r.description === 'string' ? r.description : '';
  const ownerId = typeof r.ownerId === 'string' ? r.ownerId : 'local_user';
  const version = typeof r.version === 'number' && !isNaN(r.version) && r.version > 0 ? r.version : 1;
  const schemaVersion = CURRENT_SCHEMA_VERSION;

  // Normalize steps
  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  const steps: WorkflowStep[] = rawSteps.map((stepRaw, idx) => {
    const s = (typeof stepRaw === 'object' && stepRaw !== null ? stepRaw : {}) as Record<string, unknown>;
    const stepId = typeof s.id === 'string' && s.id ? s.id : `step_${idx + 1}_${Date.now()}`;
    const actionType = (typeof s.type === 'string' && VALID_ACTION_TYPES.has(s.type as ActionType))
      ? (s.type as ActionType)
      : 'click';
    const timestamp = typeof s.timestamp === 'number' && !isNaN(s.timestamp) ? s.timestamp : Date.now();
    const url = typeof s.url === 'string' ? s.url : '';
    const sequence = typeof s.sequence === 'number' && !isNaN(s.sequence) ? s.sequence : idx + 1;

    const step: WorkflowStep = {
      id: stepId,
      type: actionType,
      timestamp,
      url,
      sequence,
    };

    if (typeof s.title === 'string') step.title = s.title;
    if (s.target && typeof s.target === 'object') step.target = s.target as TargetDescriptor;
    if (s.position && typeof s.position === 'object') step.position = s.position as Position;
    if (s.value !== undefined) step.value = s.value === null ? null : String(s.value);
    if (typeof s.sensitive === 'boolean') step.sensitive = s.sensitive;
    if (typeof s.key === 'string') step.key = s.key;
    if (s.verification && typeof s.verification === 'object') step.verification = s.verification as any;
    if (s.extraction && typeof s.extraction === 'object') step.extraction = s.extraction as any;
    if (s.condition && typeof s.condition === 'object') step.condition = s.condition as any;

    return step;
  });

  // Normalize variables
  const rawVariables = Array.isArray(r.variables) ? r.variables : [];
  const variables: WorkflowVariable[] = rawVariables
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      name: typeof v.name === 'string' ? v.name : 'variable',
      required: Boolean(v.required),
      ...(typeof v.type === 'string' && VALID_VARIABLE_DATA_TYPES.has(v.type) ? { type: v.type as any } : {}),
      ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue as any } : {}),
      ...(typeof v.sensitive === 'boolean' ? { sensitive: v.sensitive } : {}),
      ...(typeof v.description === 'string' ? { description: v.description } : {}),
    }));

  // Normalize timestamps to ISO strings
  let createdAt: string;
  if (typeof r.createdAt === 'string' && isValidDateString(r.createdAt)) {
    createdAt = new Date(r.createdAt).toISOString();
  } else if (typeof r.createdAt === 'number' && !isNaN(r.createdAt)) {
    createdAt = new Date(r.createdAt).toISOString();
  } else {
    createdAt = new Date().toISOString();
  }

  let updatedAt: string;
  if (typeof r.updatedAt === 'string' && isValidDateString(r.updatedAt)) {
    updatedAt = new Date(r.updatedAt).toISOString();
  } else if (typeof r.updatedAt === 'number' && !isNaN(r.updatedAt)) {
    updatedAt = new Date(r.updatedAt).toISOString();
  } else {
    updatedAt = createdAt;
  }

  const normalized: Workflow = {
    id,
    name,
    description,
    ownerId,
    version,
    schemaVersion,
    steps,
    variables,
    createdAt,
    updatedAt,
  };

  if (r.datasetConfig && typeof r.datasetConfig === 'object') {
    normalized.datasetConfig = r.datasetConfig as any;
  }

  if (r.settings && typeof r.settings === 'object') {
    normalized.settings = r.settings as any;
  }

  assertValidWorkflow(normalized);
  return normalized;
}
