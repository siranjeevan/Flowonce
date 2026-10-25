export type ActionType = 
  | 'click'
  | 'input'
  | 'keydown'
  | 'keypress'
  | 'scroll'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'drag'
  | 'navigate'
  | 'video_interaction'
  | 'video'
  | 'wait'
  | 'copy'
  | 'paste'
  | 'extract'
  | 'condition';

export interface Position {
  clientX?: number;
  clientY?: number;
  relativeX?: number;
  relativeY?: number;
  scrollX?: number;
  scrollY?: number;
}

export interface TargetDescriptor {
  id?: string;
  testId?: string;
  name?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
  text?: string | null;
  placeholder?: string | null;
  href?: string | null;
  src?: string | null;
  tag?: string;
  selector?: string;
  relativePosition?: Position;
  element?: string; // used for video fallback
  containerText?: string | null; // Context text from parent card, table row, or list item
  frameSelector?: string | null; // Selector for containing iframe if applicable
  contextSnippet?: string | null; // Nearby heading or label context
}

import type { StepVerificationConfig } from '../../replay/verification-types';

export type ExtractionType =
  | 'text_content'
  | 'inner_text'
  | 'attribute'
  | 'input_value'
  | 'checked_state'
  | 'selected_value'
  | 'href'
  | 'src'
  | 'document_title'
  | 'current_url';

export interface OutputExtractionConfig {
  id: string;
  target?: TargetDescriptor;
  type: ExtractionType;
  attributeName?: string;
  variableName: string;
  required?: boolean;
  allowOverwrite?: boolean;
  timeoutMs?: number;
  onFailure?: 'fail' | 'pause' | 'continue';
}

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'exists'
  | 'is_empty'
  | 'contains'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'starts_with'
  | 'ends_with';

export interface StepConditionConfig {
  source: 'variable' | 'verification';
  name?: string; // variable name if source === 'variable', or stepId if source === 'verification'
  operator: ConditionOperator;
  value?: string | number | boolean | null;
  onTrue?: string; // target step ID, 'next', or 'end'
  onFalse?: string; // target step ID, 'next', or 'end'
}

export interface WorkflowStep {
  id: string;
  type: ActionType;
  timestamp: number;
  url: string;
  title?: string;
  target?: TargetDescriptor;
  position?: Position;
  value?: string | null;
  sensitive?: boolean;
  key?: string;
  sequence: number;
  verification?: StepVerificationConfig;
  extraction?: OutputExtractionConfig;
  condition?: StepConditionConfig;
}

export type VariableDataType = 'string' | 'number' | 'boolean' | 'null' | 'any';

export interface WorkflowVariable {
  name: string;
  required: boolean;
  type?: VariableDataType;
  defaultValue?: string | number | boolean | null;
  sensitive?: boolean;
  description?: string;
}

export interface WorkflowDatasetConfig {
  defaultSourceType?: 'csv' | 'json';
  requiredColumns?: string[];
  maxRows?: number;
}

export interface WorkflowSettings {
  maxStepBudget?: number;
  defaultTimeoutMs?: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  version: number;
  schemaVersion: number;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  datasetConfig?: WorkflowDatasetConfig;
  settings?: WorkflowSettings;
  createdAt: string;
  updatedAt: string;
}
