export type ExecutionStatus = 'SUCCESS' | 'FAILED' | 'RECOVERY_REQUIRED' | 'CANCELLED';

export type FailureCategory =
  | 'TIMEOUT'
  | 'TARGET_NOT_FOUND'
  | 'VERIFICATION_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'SIDE_EFFECT_REFUSED'
  | 'UNEXPECTED'
  | 'NONE';

export interface ExecutionHistoryEntry {
  id: string;
  sessionId: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  startTime: number;
  endTime: number;
  durationMs: number;
  totalSteps: number;
  executedSteps: number;
  verifiedSteps: number;
  failedStepId?: string;
  failureCategory: FailureCategory;
  failureReason?: string;
  recoveryAttempts: number;
  datasetRecordIndex?: number;
  datasetTotalRecords?: number;
}

export interface ExecutionAnalytics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageDurationMs: number;
  medianDurationMs: number;
  failureBreakdown: Record<FailureCategory, number>;
  frequentFailingSteps: { stepId: string; count: number }[];
  recoveryFrequency: number;
}
