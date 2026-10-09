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
  | 'paste';

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
  tag?: string;
  selector?: string;
  relativePosition?: Position;
  element?: string; // used for video fallback
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
}

export interface WorkflowVariable {
  name: string;
  required: boolean;
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
  createdAt: string;
  updatedAt: string;
}
