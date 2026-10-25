import type { WorkflowStep } from '../../shared/types/workflow';

export interface ComponentPort {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'any';
  required?: boolean;
  defaultValue?: any;
  description?: string;
}

export interface WorkflowComponent {
  id: string;
  name: string;
  description?: string;
  version: string;
  inputs: ComponentPort[];
  outputs: ComponentPort[];
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  authorId?: string;
}

export interface ComponentInvocationStep extends WorkflowStep {
  componentId: string;
  componentVersion?: string;
  inputBindings?: Record<string, string>;
  outputBindings?: Record<string, string>;
}
