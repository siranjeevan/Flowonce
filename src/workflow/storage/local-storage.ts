import type { Workflow } from '../../shared/types/workflow';
import { WorkflowStorage } from './WorkflowStorage';

/**
 * Backward-compatible wrapper around WorkflowStorage.
 * Delegates all operations to the centralized, strongly-typed WorkflowStorage singleton.
 */
export class LocalStorageManager {
  static async saveWorkflow(workflow: Workflow): Promise<void> {
    await WorkflowStorage.createWorkflow(workflow);
  }

  static async getWorkflows(): Promise<Workflow[]> {
    return WorkflowStorage.getAllWorkflows();
  }

  static async getWorkflow(id: string): Promise<Workflow | null> {
    return WorkflowStorage.getWorkflowById(id);
  }

  static async deleteWorkflow(id: string): Promise<void> {
    await WorkflowStorage.deleteWorkflow(id);
  }
}
