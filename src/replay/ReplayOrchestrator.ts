import type { Workflow, WorkflowStep } from '../shared/types/workflow';

export class ReplayOrchestrator {
  private workflow: Workflow | null = null;
  private currentStepIndex = 0;
  private isRunning = false;
  private variables: Record<string, string> = {};
  private speedMultiplier = 1;

  public start(workflow: Workflow, variables: Record<string, string> = {}, speedMultiplier: number = 1) {
    this.workflow = workflow;
    this.variables = variables;
    this.speedMultiplier = speedMultiplier;
    this.currentStepIndex = 0;
    this.isRunning = true;
    this.executeNextStep();
  }

  public stop() {
    this.isRunning = false;
  }

  private async executeNextStep() {
    if (!this.isRunning || !this.workflow || this.currentStepIndex >= this.workflow.steps.length) {
      this.isRunning = false;
      chrome.runtime.sendMessage({ type: 'REPLAY_FINISHED', workflowId: this.workflow?.id }).catch(() => {});
      return;
    }

    const step = this.workflow.steps[this.currentStepIndex];
    const preparedStep = this.prepareStepVariables(step);

    chrome.runtime.sendMessage({ 
      type: 'REPLAY_STEP_START', 
      workflowId: this.workflow.id,
      index: this.currentStepIndex,
      total: this.workflow.steps.length,
      stepType: step.type 
    }).catch(() => {});

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error("No active tab found");

      if (tab.url && preparedStep.url && new URL(tab.url).origin !== new URL(preparedStep.url).origin) {
        await chrome.tabs.update(tab.id, { url: preparedStep.url });
        // Wait for page load
        const loadDelay = Math.max(200, 2000 / this.speedMultiplier);
        await new Promise(r => setTimeout(r, loadDelay));
      }

      // Ask content script to execute step
      const result = await chrome.tabs.sendMessage(tab.id, { 
        type: 'EXECUTE_STEP', 
        payload: { step: preparedStep, speedMultiplier: this.speedMultiplier }
      });

      if (result && result.success) {
        this.currentStepIndex++;
        chrome.runtime.sendMessage({ type: 'REPLAY_STEP_SUCCESS', index: this.currentStepIndex }).catch(() => {});
        // Apply speed multiplier to the base delay
        const delayMs = Math.max(0, 1000 / this.speedMultiplier);
        setTimeout(() => this.executeNextStep(), delayMs);
      } else {
        throw new Error(result?.error || 'Unknown execution error');
      }

    } catch (e: any) {
      this.isRunning = false;
      console.error("Replay failed at step", this.currentStepIndex, e);
      chrome.runtime.sendMessage({ 
        type: 'REPLAY_FAILED', 
        workflowId: this.workflow?.id,
        error: e.message, 
        index: this.currentStepIndex 
      }).catch(() => {});
    }
  }

  private prepareStepVariables(step: WorkflowStep): WorkflowStep {
    const cloned = { ...step };
    if (cloned.value) {
      cloned.value = cloned.value.replace(/{{([^}]+)}}/g, (_, varName) => {
        return this.variables[varName] || `{{${varName}}}`;
      });
    }
    return cloned;
  }
}

export const orchestrator = new ReplayOrchestrator();
