import type { WorkflowRole, WorkflowOperation, ConflictCheckResult } from './collaboration-types';
import type { Workflow, WorkflowStep, WorkflowVariable } from '../shared/types/workflow';

export class CollaborationManager {
  private static ROLE_PERMISSIONS: Record<WorkflowRole, Set<WorkflowOperation>> = {
    owner: new Set(['edit', 'run', 'delete', 'share', 'export']),
    editor: new Set(['edit', 'run', 'export']),
    runner: new Set(['run', 'export']),
    viewer: new Set(['export']),
  };

  /**
   * Resolves the effective role of a user for a given workflow
   */
  static getUserRole(workflow: Workflow, userId?: string): WorkflowRole {
    const effectiveUserId = userId || 'local_user';
    if (!workflow.ownerId || workflow.ownerId === 'local_user' || workflow.ownerId === effectiveUserId) {
      return 'owner';
    }

    const members = (workflow as any).collaboration?.members || [];
    const member = members.find((m: any) => m.userId === effectiveUserId);
    return member?.role || 'viewer';
  }

  /**
   * Evaluates if a user is permitted to perform a specific workflow operation
   */
  static canUserPerform(
    workflow: Workflow,
    userId: string | undefined,
    operation: WorkflowOperation
  ): { allowed: boolean; reason?: string } {
    const role = this.getUserRole(workflow, userId);
    const allowedOps = this.ROLE_PERMISSIONS[role] || new Set();

    if (allowedOps.has(operation)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `User with role "${role}" is not permitted to perform "${operation}" on workflow "${workflow.name}".`,
    };
  }

  /**
   * Detects concurrent modification conflicts based on base revision vs current stored revision
   */
  static checkRevisionConflict(currentWorkflow: Workflow, baseRevision: number): ConflictCheckResult {
    const currentRev = currentWorkflow.version || 1;
    if (currentRev !== baseRevision) {
      return {
        hasConflict: true,
        serverRevision: currentRev,
        localRevision: baseRevision,
        message: `Workflow "${currentWorkflow.name}" has been modified by another session (revision ${currentRev} vs your base revision ${baseRevision}).`,
      };
    }

    return { hasConflict: false };
  }

  /**
   * Redacts sensitive step values and variable secrets before sharing/exporting across team members
   */
  static sanitizeForSharing(workflow: Workflow): Workflow {
    const cloned: Workflow = JSON.parse(JSON.stringify(workflow));

    // Redact step values if sensitive
    cloned.steps = cloned.steps.map((step: WorkflowStep) => {
      if (step.sensitive && step.value) {
        return {
          ...step,
          value: '[REDACTED_SECRET]',
        };
      }
      return step;
    });

    // Redact variable defaults if sensitive
    if (cloned.variables) {
      cloned.variables = cloned.variables.map((v: WorkflowVariable) => {
        if (v.sensitive && v.defaultValue) {
          return {
            ...v,
            defaultValue: '[REDACTED_SECRET]',
          };
        }
        return v;
      });
    }

    return cloned;
  }
}
