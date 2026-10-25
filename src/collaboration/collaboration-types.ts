export type WorkflowRole = 'owner' | 'editor' | 'runner' | 'viewer';

export type WorkflowOperation = 'edit' | 'run' | 'delete' | 'share' | 'export';

export interface CollaborationMember {
  userId: string;
  email: string;
  role: WorkflowRole;
  addedAt: string;
}

export interface WorkflowCollaborationMeta {
  ownerId: string;
  members: CollaborationMember[];
  revision: number;
  lastEditedBy?: string;
  lastEditedAt?: string;
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  serverRevision?: number;
  localRevision?: number;
  message?: string;
}
