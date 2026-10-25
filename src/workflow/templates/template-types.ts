import type { WorkflowStep, WorkflowVariable } from '../../shared/types/workflow';

export type TemplateCategory = 'form' | 'extraction' | 'navigation' | 'data-driven' | 'ecommerce';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  version: string;
  tags: string[];
  variables: WorkflowVariable[];
  steps: WorkflowStep[];
  author?: string;
  isBuiltin?: boolean;
}
