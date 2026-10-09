import type { Workflow, WorkflowStep } from '../shared/types/workflow';
import { ActionExecutor } from './ActionExecutor';

export interface ReplayState {
  currentStepIndex: number;
  isRunning: boolean;
  isFinished: boolean;
  error?: string;
}

export type ReplayCallback = (state: ReplayState) => void;

export class ReplayEngine {
  private workflow: Workflow | null = null;
  private state: ReplayState = {
    currentStepIndex: 0,
    isRunning: false,
    isFinished: false
  };
  private onStateChange: ReplayCallback | null = null;
  private variables: Record<string, string> = {};

  constructor(onStateChange?: ReplayCallback) {
    if (onStateChange) this.onStateChange = onStateChange;
  }

  public loadWorkflow(workflow: Workflow, variables: Record<string, string> = {}) {
    this.workflow = workflow;
    this.variables = variables;
    this.state = {
      currentStepIndex: 0,
      isRunning: false,
      isFinished: false
    };
    this.emitState();
  }

  public async start() {
    if (!this.workflow || this.workflow.steps.length === 0) return;
    
    this.state.isRunning = true;
    this.state.isFinished = false;
    this.state.error = undefined;
    this.emitState();

    try {
      while (this.state.currentStepIndex < this.workflow.steps.length && this.state.isRunning) {
        const step = this.workflow.steps[this.state.currentStepIndex];
        
        // Wait strategy: Simple wait for now before each action to ensure DOM changes settle.
        // Can be replaced with MutationObserver logic.
        await new Promise(r => setTimeout(r, 800));

        // Inject variables
        const preparedStep = this.prepareStepVariables(step);

        await ActionExecutor.execute(preparedStep);
        
        this.state.currentStepIndex++;
        this.emitState();
      }

      if (this.state.currentStepIndex >= this.workflow.steps.length) {
        this.state.isFinished = true;
        this.state.isRunning = false;
        this.emitState();
      }

    } catch (e: any) {
      this.state.isRunning = false;
      this.state.error = e.message || 'Execution failed';
      this.emitState();
    }
  }

  public stop() {
    this.state.isRunning = false;
    this.emitState();
  }

  private prepareStepVariables(step: WorkflowStep): WorkflowStep {
    const cloned = { ...step };
    if (cloned.value) {
      // replace {{varName}} with variable value
      cloned.value = cloned.value.replace(/{{([^}]+)}}/g, (_, varName) => {
        return this.variables[varName] || `{{${varName}}}`;
      });
    }
    return cloned;
  }

  private emitState() {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }
}
