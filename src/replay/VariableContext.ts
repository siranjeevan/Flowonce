import type { WorkflowVariable, VariableDataType } from '../shared/types/workflow';

/**
 * Custom error thrown when a required variable cannot be resolved.
 */
export class MissingRequiredVariableError extends Error {
  public readonly variableName: string;

  constructor(variableName: string, message?: string) {
    super(message || `Required variable "${variableName}" is missing and has no fallback value.`);
    this.name = 'MissingRequiredVariableError';
    this.variableName = variableName;
  }
}

/**
 * Custom error thrown when an invalid variable name or assignment is attempted.
 */
export class VariableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariableValidationError';
  }
}

export const RESERVED_SYSTEM_VARS = new Set([
  '_stepIndex',
  '_recordIndex',
  '_timestamp',
  '_workflowId',
  '_sessionId',
  '_currentUrl',
]);

export type RuntimeVariableValue = string | number | boolean | null;

/**
 * Manages runtime variables with strict precedence, type safety,
 * record-level isolation, and safe interpolation.
 *
 * Precedence Order (highest to lowest):
 * 1. System variables (reserved, read-only, e.g. _stepIndex, _recordIndex)
 * 2. Extracted variables (DOM outputs captured during the current execution)
 * 3. Dataset record values (current CSV/JSON record inputs)
 * 4. User inputs (runtime values provided when launching replay)
 * 5. Workflow defaults (declared in workflow.variables with defaultValue)
 */
export interface VariableContextOptions {
  declarations?: WorkflowVariable[];
  workflowDefaults?: Record<string, unknown>;
  userInputs?: Record<string, unknown>;
  recordData?: Record<string, unknown>;
  systemVariables?: Record<string, unknown>;
}

export class VariableContext {
  private systemVars: Map<string, RuntimeVariableValue> = new Map();
  private extractedVars: Map<string, RuntimeVariableValue> = new Map();
  private datasetVars: Map<string, RuntimeVariableValue> = new Map();
  private userVars: Map<string, RuntimeVariableValue> = new Map();
  private defaultVars: Map<string, RuntimeVariableValue> = new Map();
  private declarations: Map<string, WorkflowVariable> = new Map();

  constructor(
    declarationsOrOptions: WorkflowVariable[] | VariableContextOptions = [],
    userInputs: Record<string, unknown> = {},
    datasetRecord: Record<string, unknown> = {},
    systemInputs: Record<string, unknown> = {}
  ) {
    let declarations: WorkflowVariable[] = [];
    let uInputs: Record<string, unknown> = userInputs;
    let dRecord: Record<string, unknown> = datasetRecord;
    let sInputs: Record<string, unknown> = systemInputs;

    if (!Array.isArray(declarationsOrOptions)) {
      declarations = declarationsOrOptions.declarations || [];
      uInputs = declarationsOrOptions.userInputs || {};
      dRecord = declarationsOrOptions.recordData || {};
      sInputs = declarationsOrOptions.systemVariables || {};
      if (declarationsOrOptions.workflowDefaults) {
        for (const [key, val] of Object.entries(declarationsOrOptions.workflowDefaults)) {
          if (val !== undefined) {
            this.defaultVars.set(key, val as RuntimeVariableValue);
          }
        }
      }
    } else {
      declarations = declarationsOrOptions;
    }

    // 1. Register declarations and default values
    for (const decl of declarations) {
      this.validateVariableName(decl.name);
      this.declarations.set(decl.name, { ...decl });
      if (decl.defaultValue !== undefined && !this.defaultVars.has(decl.name)) {
        this.defaultVars.set(decl.name, this.coerceValue(decl.defaultValue, decl.type));
      }
    }

    // 2. Register user inputs
    for (const [key, val] of Object.entries(uInputs)) {
      if (val !== undefined) {
        const decl = this.declarations.get(key);
        this.userVars.set(key, this.coerceValue(val, decl?.type));
      }
    }

    // 3. Register dataset record values
    for (const [key, val] of Object.entries(dRecord)) {
      if (val !== undefined) {
        const decl = this.declarations.get(key);
        this.datasetVars.set(key, this.coerceValue(val, decl?.type));
      }
    }

    // 4. Register system variables
    for (const [key, val] of Object.entries(sInputs)) {
      this.systemVars.set(key, this.coerceValue(val));
    }

    // 5. Enforce required variable presence
    this.validateRequiredVariables();
  }

  /**
   * Validates that variable name is not reserved and matches valid identifier format.
   */
  public validateVariableName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new VariableValidationError('Variable name must be a non-empty string');
    }
    if (name.startsWith('_') || RESERVED_SYSTEM_VARS.has(name)) {
      throw new VariableValidationError(`Variable name "${name}" is reserved for system variables`);
    }
  }

  /**
   * Sets or updates a system variable.
   */
  public setSystemVariable(name: string, value: RuntimeVariableValue): void {
    this.systemVars.set(name, value);
  }

  /**
   * Sets an extracted variable with optional overwrite protection.
   */
  public setExtracted(name: string, value: unknown, allowOverwrite: boolean = true): void {
    this.validateVariableName(name);

    if (RESERVED_SYSTEM_VARS.has(name)) {
      throw new VariableValidationError(`Cannot extract into reserved system variable "${name}"`);
    }

    if (!allowOverwrite && this.extractedVars.has(name)) {
      throw new VariableValidationError(`Variable "${name}" has already been extracted and allowOverwrite is false`);
    }

    const decl = this.declarations.get(name);
    const coerced = this.coerceValue(value, decl?.type);
    this.extractedVars.set(name, coerced);
  }

  /**
   * Resolves a variable by name applying the precedence rules.
   * Returns undefined if variable is missing.
   */
  public get(name: string): RuntimeVariableValue | undefined {
    // 1. System variables (highest)
    if (this.systemVars.has(name)) {
      return this.systemVars.get(name);
    }

    // 2. Extracted variables
    if (this.extractedVars.has(name)) {
      return this.extractedVars.get(name);
    }

    // 3. Dataset record values
    if (this.datasetVars.has(name)) {
      return this.datasetVars.get(name);
    }

    // 4. User inputs
    if (this.userVars.has(name)) {
      return this.userVars.get(name);
    }

    // 5. Workflow defaults (lowest)
    if (this.defaultVars.has(name)) {
      return this.defaultVars.get(name);
    }

    return undefined;
  }

  /**
   * Checks if variable exists in any layer of the context.
   */
  public has(name: string): boolean {
    return (
      this.systemVars.has(name) ||
      this.extractedVars.has(name) ||
      this.datasetVars.has(name) ||
      this.userVars.has(name) ||
      this.defaultVars.has(name)
    );
  }

  /**
   * Resolves a variable, checking if it is declared as required.
   * Throws MissingRequiredVariableError if required and missing.
   */
  public resolve(name: string, required?: boolean): RuntimeVariableValue {
    const isRequired = required ?? this.declarations.get(name)?.required ?? false;
    const value = this.get(name);

    if (value === undefined) {
      if (isRequired) {
        throw new MissingRequiredVariableError(name);
      }
      return null;
    }

    return value;
  }

  /**
   * Validates that all required workflow variables are present.
   */
  public validateRequiredVariables(): void {
    for (const [name, decl] of this.declarations.entries()) {
      if (decl.required) {
        const val = this.get(name);
        if (val === undefined || val === null) {
          throw new MissingRequiredVariableError(name);
        }
      }
    }
  }

  /**
   * Safely interpolates {{variableName}} tokens within a string template.
   *
   * @param template - The string template containing {{tokens}}
   * @param options - Interpolation options (e.g. throwOnMissing)
   */
  public interpolate(
    template: string,
    options: { throwOnMissing?: boolean; strict?: boolean } = {}
  ): string {
    if (!template || typeof template !== 'string') return template;

    return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, varName) => {
      const val = this.get(varName);

      if (val === undefined) {
        const decl = this.declarations.get(varName);
        if (options.throwOnMissing || options.strict || decl?.required) {
          throw new MissingRequiredVariableError(varName);
        }
        // Preserve original token when unbound and not strictly required
        return match;
      }

      if (val === null) return '';
      return String(val);
    });
  }

  /**
   * Creates an isolated context for a specific dataset record.
   * Inherits declarations, workflow defaults, user inputs, and system inputs,
   * but isolates extracted variables and sets the new record variables.
   */
  public createRecordContext(
    recordData: Record<string, unknown>,
    recordIndex: number
  ): VariableContext {
    const nextSystem = Object.fromEntries(this.systemVars.entries());
    nextSystem['_recordIndex'] = recordIndex;

    const ctx = new VariableContext(
      Array.from(this.declarations.values()),
      Object.fromEntries(this.userVars.entries()),
      recordData,
      nextSystem
    );

    return ctx;
  }

  /**
   * Returns a consolidated flat snapshot of all resolved variables.
   */
  public getAllVariables(): Record<string, RuntimeVariableValue> {
    const result: Record<string, RuntimeVariableValue> = {};

    // Apply lowest to highest precedence
    for (const [k, v] of this.defaultVars.entries()) result[k] = v;
    for (const [k, v] of this.userVars.entries()) result[k] = v;
    for (const [k, v] of this.datasetVars.entries()) result[k] = v;
    for (const [k, v] of this.extractedVars.entries()) result[k] = v;
    for (const [k, v] of this.systemVars.entries()) result[k] = v;

    return result;
  }

  /**
   * Returns a serializable representation for persistence across service worker restarts.
   */
  public toSerializable(): {
    declarations: WorkflowVariable[];
    userVars: Record<string, RuntimeVariableValue>;
    datasetVars: Record<string, RuntimeVariableValue>;
    extractedVars: Record<string, RuntimeVariableValue>;
    systemVars: Record<string, RuntimeVariableValue>;
    extractedVariables: Record<string, RuntimeVariableValue>;
    recordData: Record<string, RuntimeVariableValue>;
  } {
    const user = Object.fromEntries(this.userVars.entries());
    const dataset = Object.fromEntries(this.datasetVars.entries());
    const extracted = Object.fromEntries(this.extractedVars.entries());
    const system = Object.fromEntries(this.systemVars.entries());
    return {
      declarations: Array.from(this.declarations.values()),
      userVars: user,
      datasetVars: dataset,
      extractedVars: extracted,
      systemVars: system,
      extractedVariables: extracted,
      recordData: dataset,
    };
  }

  /**
   * Reconstructs a VariableContext from persisted data.
   */
  public static fromSerializable(
    data: {
      declarations?: WorkflowVariable[];
      userVars?: Record<string, unknown>;
      datasetVars?: Record<string, unknown>;
      recordData?: Record<string, unknown>;
      extractedVars?: Record<string, unknown>;
      extractedVariables?: Record<string, unknown>;
      systemVars?: Record<string, unknown>;
    },
    workflowDeclarations?: WorkflowVariable[]
  ): VariableContext {
    const decls = workflowDeclarations || data.declarations || [];
    const ctx = new VariableContext(
      decls,
      data.userVars || {},
      data.datasetVars || data.recordData || {},
      data.systemVars || {}
    );

    const ext = data.extractedVars || data.extractedVariables;
    if (ext) {
      for (const [k, v] of Object.entries(ext)) {
        ctx.extractedVars.set(k, ctx.coerceValue(v));
      }
    }

    return ctx;
  }

  /**
   * Coerces a value to the expected type, avoiding accidental string conversions
   * of false, 0, or null.
   */
  private coerceValue(val: unknown, expectedType?: VariableDataType): RuntimeVariableValue {
    if (val === undefined || val === null) {
      return null;
    }

    if (expectedType === 'boolean') {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        if (lower === 'true' || lower === '1') return true;
        if (lower === 'false' || lower === '0') return false;
      }
      return Boolean(val);
    }

    if (expectedType === 'number') {
      if (typeof val === 'number') return isNaN(val) ? null : val;
      if (typeof val === 'string') {
        const num = Number(val);
        return isNaN(num) ? null : num;
      }
      return null;
    }

    if (expectedType === 'string') {
      return String(val);
    }

    // Default 'any' or untyped
    if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
      return val;
    }

    return String(val);
  }
}
