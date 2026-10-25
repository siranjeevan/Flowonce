import { describe, it, expect } from 'vitest';
import {
  VariableContext,
  MissingRequiredVariableError,
  VariableValidationError,
  RESERVED_SYSTEM_VARS,
} from '../src/replay/VariableContext';
import type { WorkflowVariable } from '../src/shared/types/workflow';

describe('Phase 7: VariableContext & Runtime Variable Precedence', () => {
  const sampleWorkflowDeclarations: WorkflowVariable[] = [
    { name: 'apiUrl', type: 'string', required: false, defaultValue: 'https://api.default.com' },
    { name: 'timeout', type: 'number', required: false, defaultValue: 3000 },
    { name: 'debug', type: 'boolean', required: false, defaultValue: false },
    { name: 'requiredApiKey', type: 'string', required: true },
    { name: 'optionalField', type: 'string', required: false },
  ];

  it('1. Enforces strict precedence: System > Extracted > Dataset Record > User Inputs > Workflow Defaults', () => {
    const ctx = new VariableContext({
      declarations: sampleWorkflowDeclarations,
      workflowDefaults: { apiUrl: 'https://default.com', timeout: 5000 },
      userInputs: { apiUrl: 'https://user.com', requiredApiKey: 'key-123' },
      recordData: { apiUrl: 'https://dataset.com', batchId: 'batch-9' },
      systemVariables: { _sessionId: 'ses-100', _stepIndex: 1 },
    });

    // Workflow defaults are overridden by user inputs
    expect(ctx.get('timeout')).toBe(5000);

    // Record data overrides user inputs
    expect(ctx.get('apiUrl')).toBe('https://dataset.com');

    // Extracted variables override record data
    ctx.setExtracted('apiUrl', 'https://extracted.com');
    expect(ctx.get('apiUrl')).toBe('https://extracted.com');

    // System variables cannot be overridden by extracted variables
    expect(() => {
      ctx.setExtracted('_stepIndex', 99);
    }).toThrow(VariableValidationError);
    expect(ctx.get('_stepIndex')).toBe(1);
    expect(ctx.get('_sessionId')).toBe('ses-100');
  });

  it('2. Correctly casts and validates typed variables', () => {
    const declarations: WorkflowVariable[] = [
      { name: 'count', type: 'number', required: false },
      { name: 'flag', type: 'boolean', required: false },
      { name: 'text', type: 'string', required: false },
    ];

    const ctx = new VariableContext({
      declarations,
      userInputs: {
        count: '42',
        flag: 'true',
        text: 12345,
      },
    });

    expect(ctx.get('count')).toBe(42);
    expect(ctx.get('flag')).toBe(true);
    expect(ctx.get('text')).toBe('12345');
  });

  it('3. Throws MissingRequiredVariableError when a required variable has no value', () => {
    expect(() => {
      new VariableContext({
        declarations: sampleWorkflowDeclarations,
        userInputs: {}, // missing requiredApiKey
      });
    }).toThrow(MissingRequiredVariableError);
  });

  it('4. Distinguishes between empty string and missing variable', () => {
    const declarations: WorkflowVariable[] = [
      { name: 'emptyVar', type: 'string', required: true, defaultValue: 'fallback' },
    ];

    const ctx = new VariableContext({
      declarations,
      userInputs: { emptyVar: '' },
    });

    // Empty string is a valid explicitly provided value, not undefined
    expect(ctx.get('emptyVar')).toBe('');
    expect(ctx.has('emptyVar')).toBe(true);
  });

  it('5. Rejects collisions with reserved system variables', () => {
    const invalidDeclarations: WorkflowVariable[] = [
      { name: '_stepIndex', type: 'number', required: false },
    ];

    expect(() => {
      new VariableContext({
        declarations: invalidDeclarations,
        userInputs: {},
      });
    }).toThrow(VariableValidationError);

    // Verify all reserved keys are defined
    expect(RESERVED_SYSTEM_VARS.has('_recordIndex')).toBe(true);
    expect(RESERVED_SYSTEM_VARS.has('_sessionId')).toBe(true);
    expect(RESERVED_SYSTEM_VARS.has('_timestamp')).toBe(true);
  });

  it('6. createRecordContext isolates records and resets extracted variables without leaking across rows', () => {
    const baseCtx = new VariableContext({
      declarations: [
        { name: 'username', type: 'string', required: false },
        { name: 'token', type: 'string', required: false },
      ],
      userInputs: { globalEnv: 'production' },
    });

    // Record 1
    const rec1Ctx = baseCtx.createRecordContext({ username: 'alice' }, 0);
    expect(rec1Ctx.get('username')).toBe('alice');
    expect(rec1Ctx.get('_recordIndex')).toBe(0);
    rec1Ctx.setExtracted('token', 'token-alice-123');
    expect(rec1Ctx.get('token')).toBe('token-alice-123');

    // Record 2 - must NOT have token from Record 1
    const rec2Ctx = baseCtx.createRecordContext({ username: 'bob' }, 1);
    expect(rec2Ctx.get('username')).toBe('bob');
    expect(rec2Ctx.get('_recordIndex')).toBe(1);
    expect(rec2Ctx.get('token')).toBeUndefined();
    expect(rec2Ctx.has('token')).toBe(false);
  });

  it('7. Safely interpolates {{varName}} in strings without eval', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: {
        firstName: 'Jane',
        lastName: 'Doe',
        orderId: 9876,
      },
    });

    expect(ctx.interpolate('Hello {{firstName}} {{lastName}}!')).toBe('Hello Jane Doe!');
    expect(ctx.interpolate('Order #{{ orderId }} confirmed')).toBe('Order #9876 confirmed');
    expect(ctx.interpolate('Missing {{ unknownVar }} unchanged')).toBe('Missing {{ unknownVar }} unchanged');
    expect(ctx.interpolate('Non string input')).toBe('Non string input');
  });

  it('8. Supports serialization and re-hydration for service worker boot recovery', () => {
    const ctx = new VariableContext({
      declarations: sampleWorkflowDeclarations,
      workflowDefaults: { apiUrl: 'https://api.default.com' },
      userInputs: { requiredApiKey: 'secret-key-1' },
      recordData: { customer: 'Acme Corp' },
      systemVariables: { _sessionId: 'SES_RESTORE_1', _recordIndex: 3 },
    });
    ctx.setExtracted('extractedId', 'EXT_999');

    const serialized = ctx.toSerializable();
    expect(serialized.extractedVariables.extractedId).toBe('EXT_999');
    expect(serialized.recordData.customer).toBe('Acme Corp');

    // Rehydrate
    const restoredCtx = VariableContext.fromSerializable(serialized, sampleWorkflowDeclarations);
    expect(restoredCtx.get('extractedId')).toBe('EXT_999');
    expect(restoredCtx.get('customer')).toBe('Acme Corp');
    expect(restoredCtx.get('requiredApiKey')).toBe('secret-key-1');
    expect(restoredCtx.get('_recordIndex')).toBe(3);
  });
});
