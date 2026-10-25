import type { WorkflowStep } from '../../shared/types/workflow';

export interface Point {
  x: number;
  y: number;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface BuilderConnection {
  fromStepId: string;
  toStepId: string;
  type: 'next' | 'true' | 'false';
}

export interface DragState {
  stepId: string;
  startMouse: Point;
  startNode: Point;
}

export interface ConnectionDraft {
  fromStepId: string;
  type: 'next' | 'true' | 'false';
  currentMouse: Point;
}

export interface BuilderHistoryState {
  steps: WorkflowStep[];
  selectedStepId: string | null;
}
