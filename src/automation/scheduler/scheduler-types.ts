export type ScheduleType = 'once' | 'interval' | 'daily';

export type ScheduleExecutionStatus = 'IDLE' | 'SUCCESS' | 'FAILED' | 'REFUSED_SIDE_EFFECT' | 'ERROR';

export interface WorkflowSchedule {
  id: string;
  workflowId: string;
  workflowName: string;
  name: string;
  enabled: boolean;
  type: ScheduleType;
  intervalMinutes?: number;
  dailyTime?: string; // e.g. "14:30"
  scheduledTime?: number; // epoch ms for 'once'
  lastRun?: number;
  lastStatus?: ScheduleExecutionStatus;
  lastErrorMessage?: string;
  nextRun?: number;
  /**
   * Explicit user authorization required if the workflow contains actions
   * classified as EXTERNAL_SIDE_EFFECT or TOGGLE_STATE.
   */
  forceUnsafeAuthorization?: boolean;
  createdAt: string;
  updatedAt: string;
}
