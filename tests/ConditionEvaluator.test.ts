import { describe, it, expect } from 'vitest';
import { ConditionEvaluator } from '../src/replay/ConditionEvaluator';
import { VariableContext } from '../src/replay/VariableContext';
import type { StepConditionConfig, WorkflowStep } from '../src/shared/types/workflow';
import type { VerificationResult } from '../src/replay/verification-types';

describe('Phase 7: ConditionEvaluator (Non-Eval Branching Engine)', () => {
  const steps: WorkflowStep[] = [
    { id: 'step_1', type: 'navigate', url: 'https://example.com' },
    { id: 'step_2', type: 'click' },
    { id: 'step_fallback', type: 'click' },
    { id: 'step_final', type: 'click' },
  ];

  it('1. Correctly evaluates equality operators without loose coercion bugs', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: {
        numZero: 0,
        strZero: '0',
        boolFalse: false,
        emptyStr: '',
        nullVal: null,
      },
    });

    // 0 is not equal to '' in strict type-aware comparison
    const config1: StepConditionConfig = {
      source: 'variable',
      variableName: 'numZero',
      operator: 'equals',
      expectedValue: 0,
      onTrue: 'step_2',
      onFalse: 'step_fallback',
    };
    expect(ConditionEvaluator.evaluate(config1, ctx, undefined, steps).matched).toBe(true);

    const config2: StepConditionConfig = {
      source: 'variable',
      variableName: 'numZero',
      operator: 'equals',
      expectedValue: '',
      onTrue: 'step_2',
      onFalse: 'step_fallback',
    };
    expect(ConditionEvaluator.evaluate(config2, ctx, undefined, steps).matched).toBe(false);

    // false is not equal to 'false'
    const config3: StepConditionConfig = {
      source: 'variable',
      variableName: 'boolFalse',
      operator: 'equals',
      expectedValue: false,
      onTrue: 'next',
      onFalse: 'end',
    };
    expect(ConditionEvaluator.evaluate(config3, ctx, undefined, steps).matched).toBe(true);
  });

  it('2. Correctly evaluates exists and is_empty operators', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: {
        presentVar: 'hello',
        emptyVar: '',
        nullVar: null,
      },
    });

    const existsConfig: StepConditionConfig = {
      source: 'variable',
      variableName: 'presentVar',
      operator: 'exists',
      onTrue: 'next',
      onFalse: 'end',
    };
    expect(ConditionEvaluator.evaluate(existsConfig, ctx, undefined, steps).matched).toBe(true);

    const notExistsConfig: StepConditionConfig = {
      source: 'variable',
      variableName: 'missingVar',
      operator: 'exists',
      onTrue: 'next',
      onFalse: 'end',
    };
    expect(ConditionEvaluator.evaluate(notExistsConfig, ctx, undefined, steps).matched).toBe(false);

    const isEmptyConfig: StepConditionConfig = {
      source: 'variable',
      variableName: 'emptyVar',
      operator: 'is_empty',
      onTrue: 'next',
      onFalse: 'end',
    };
    expect(ConditionEvaluator.evaluate(isEmptyConfig, ctx, undefined, steps).matched).toBe(true);
  });

  it('3. Correctly evaluates string operators (contains, starts_with, ends_with)', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: {
        url: 'https://subdomain.example.com/checkout/success',
      },
    });

    expect(ConditionEvaluator.evaluate({
      source: 'variable',
      variableName: 'url',
      operator: 'contains',
      expectedValue: 'checkout',
      onTrue: 'next',
      onFalse: 'end',
    }, ctx, undefined, steps).matched).toBe(true);

    expect(ConditionEvaluator.evaluate({
      source: 'variable',
      variableName: 'url',
      operator: 'starts_with',
      expectedValue: 'https://',
      onTrue: 'next',
      onFalse: 'end',
    }, ctx, undefined, steps).matched).toBe(true);

    expect(ConditionEvaluator.evaluate({
      source: 'variable',
      variableName: 'url',
      operator: 'ends_with',
      expectedValue: 'success',
      onTrue: 'next',
      onFalse: 'end',
    }, ctx, undefined, steps).matched).toBe(true);
  });

  it('4. Correctly evaluates numeric comparison operators', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: {
        cartTotal: 150.75,
      },
    });

    expect(ConditionEvaluator.evaluate({
      source: 'variable',
      variableName: 'cartTotal',
      operator: 'greater_than',
      expectedValue: 100,
      onTrue: 'next',
      onFalse: 'end',
    }, ctx, undefined, steps).matched).toBe(true);

    expect(ConditionEvaluator.evaluate({
      source: 'variable',
      variableName: 'cartTotal',
      operator: 'less_than',
      expectedValue: 100,
      onTrue: 'next',
      onFalse: 'end',
    }, ctx, undefined, steps).matched).toBe(false);
  });

  it('5. Evaluates verification outcome branching correctly', () => {
    const verifiedResult: VerificationResult = {
      status: 'VERIFIED',
      checks: [],
      durationMs: 50,
      diagnostics: 'Element text matched',
    };

    const notVerifiedResult: VerificationResult = {
      status: 'NOT_VERIFIED',
      checks: [],
      durationMs: 50,
      diagnostics: 'Element text did not match',
    };

    const config: StepConditionConfig = {
      source: 'verification',
      operator: 'equals',
      expectedValue: 'VERIFIED',
      onTrue: 'step_final',
      onFalse: 'step_fallback',
    };

    const ctx = new VariableContext();

    const trueBranch = ConditionEvaluator.evaluate(config, ctx, verifiedResult, steps);
    expect(trueBranch.matched).toBe(true);
    expect(trueBranch.targetBranch).toBe('step_final');

    const falseBranch = ConditionEvaluator.evaluate(config, ctx, notVerifiedResult, steps);
    expect(falseBranch.matched).toBe(false);
    expect(falseBranch.targetBranch).toBe('step_fallback');
  });

  it('6. Resolves branch target steps safely, falling back to next when target is invalid', () => {
    const ctx = new VariableContext({
      declarations: [],
      userInputs: { status: 'active' },
    });

    const validTargetConfig: StepConditionConfig = {
      source: 'variable',
      variableName: 'status',
      operator: 'equals',
      expectedValue: 'active',
      onTrue: 'step_final',
      onFalse: 'next',
    };
    expect(ConditionEvaluator.evaluate(validTargetConfig, ctx, undefined, steps).targetBranch).toBe('step_final');

    const invalidTargetConfig: StepConditionConfig = {
      source: 'variable',
      variableName: 'status',
      operator: 'equals',
      expectedValue: 'active',
      onTrue: 'non_existent_step_id',
      onFalse: 'next',
    };
    // If target step ID does not exist in workflow steps, falls back safely to 'next'
    expect(ConditionEvaluator.evaluate(invalidTargetConfig, ctx, undefined, steps).targetBranch).toBe('next');
  });
});
