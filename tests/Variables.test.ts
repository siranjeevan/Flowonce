import { describe, it, expect } from 'vitest';
import { ReplayOrchestrator } from '../src/replay/ReplayOrchestrator';
import type { WorkflowStep } from '../src/shared/types/workflow';

describe('Variable Substitution', () => {
  it('replaces variables correctly', () => {
    const orchestrator = new ReplayOrchestrator();
    
    // Access private method for testing via any
    const step: WorkflowStep = {
      id: 'step1',
      sequence: 1,
      type: 'input',
      timestamp: 100,
      url: 'http://test.com',
      value: 'Hello {{user_name}}!',
    };

    orchestrator['variables'] = { user_name: 'Jeevith' };
    const preparedStep = orchestrator['prepareStepVariables'](step);

    expect(preparedStep.value).toBe('Hello Jeevith!');
  });
  
  it('leaves unbound variables as they are', () => {
    const orchestrator = new ReplayOrchestrator();
    const step: WorkflowStep = {
      id: 'step1',
      sequence: 1,
      type: 'input',
      timestamp: 100,
      url: 'http://test.com',
      value: 'Hello {{unknown}}!',
    };

    orchestrator['variables'] = {};
    const preparedStep = orchestrator['prepareStepVariables'](step);

    expect(preparedStep.value).toBe('Hello {{unknown}}!');
  });
});
