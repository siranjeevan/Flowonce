import type { Workflow } from '../../shared/types/workflow';

export class LocalStorageManager {
  private static WORKFLOWS_KEY = 'flowonce_workflows';

  static async saveWorkflow(workflow: Workflow): Promise<void> {
    const workflows = await this.getWorkflows();
    const existingIndex = workflows.findIndex(w => w.id === workflow.id);
    
    if (existingIndex >= 0) {
      workflows[existingIndex] = workflow;
    } else {
      workflows.push(workflow);
    }
    
    await chrome.storage.local.set({ [this.WORKFLOWS_KEY]: workflows });
  }

  static async getWorkflows(): Promise<Workflow[]> {
    const data = await chrome.storage.local.get(this.WORKFLOWS_KEY);
    return (data[this.WORKFLOWS_KEY] as Workflow[]) || [];
  }

  static async getWorkflow(id: string): Promise<Workflow | null> {
    const workflows = await this.getWorkflows();
    return workflows.find(w => w.id === id) || null;
  }

  static async deleteWorkflow(id: string): Promise<void> {
    const workflows = await this.getWorkflows();
    const filtered = workflows.filter(w => w.id !== id);
    await chrome.storage.local.set({ [this.WORKFLOWS_KEY]: filtered });
  }
}
