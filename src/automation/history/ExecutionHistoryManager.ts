import type { ExecutionHistoryEntry, ExecutionAnalytics, FailureCategory } from './history-types';
import { STORAGE_KEYS } from '../../workflow/storage/storage-keys';

export class ExecutionHistoryManager {
  private static MAX_ENTRIES = 100;

  /**
   * Retrieves execution history, optionally filtered by workflowId
   */
  static async getHistory(workflowId?: string, limit = 100): Promise<ExecutionHistoryEntry[]> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return [];
    }

    const res = await chrome.storage.local.get(STORAGE_KEYS.EXECUTION_HISTORY);
    const raw = res[STORAGE_KEYS.EXECUTION_HISTORY];
    if (!Array.isArray(raw)) return [];

    let filtered = raw as ExecutionHistoryEntry[];
    if (workflowId) {
      filtered = filtered.filter((e) => e.workflowId === workflowId);
    }

    return filtered.slice(0, limit);
  }

  /**
   * Records a new execution entry, bounded to MAX_ENTRIES
   */
  static async recordEntry(entry: ExecutionHistoryEntry): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    const res = await chrome.storage.local.get(STORAGE_KEYS.EXECUTION_HISTORY);
    const raw = res[STORAGE_KEYS.EXECUTION_HISTORY];
    const existing: ExecutionHistoryEntry[] = Array.isArray(raw)
      ? (raw as ExecutionHistoryEntry[])
      : [];

    // Redact sensitive values from failure reason or text
    const cleanEntry: ExecutionHistoryEntry = {
      ...entry,
      failureReason: entry.failureReason
        ? entry.failureReason.replace(/(password|token|secret|key)=([^&\s]+)/gi, '$1=[REDACTED]')
        : undefined,
    };

    // Prepend newest entry and clamp to MAX_ENTRIES
    const updated = [cleanEntry, ...existing].slice(0, this.MAX_ENTRIES);

    await chrome.storage.local.set({
      [STORAGE_KEYS.EXECUTION_HISTORY]: updated,
    });
  }

  /**
   * Computes statistical analytics from persisted execution history
   */
  static async getAnalytics(workflowId?: string): Promise<ExecutionAnalytics> {
    const history = await this.getHistory(workflowId, 100);

    const breakdown: Record<FailureCategory, number> = {
      TIMEOUT: 0,
      TARGET_NOT_FOUND: 0,
      VERIFICATION_FAILED: 0,
      BUDGET_EXCEEDED: 0,
      SIDE_EFFECT_REFUSED: 0,
      UNEXPECTED: 0,
      NONE: 0,
    };

    if (history.length === 0) {
      return {
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        averageDurationMs: 0,
        medianDurationMs: 0,
        failureBreakdown: breakdown,
        frequentFailingSteps: [],
        recoveryFrequency: 0,
      };
    }

    let totalDuration = 0;
    let successCount = 0;
    let failureCount = 0;
    let totalRecoveries = 0;
    const durations: number[] = [];
    const stepFailureMap = new Map<string, number>();

    for (const item of history) {
      totalDuration += item.durationMs;
      durations.push(item.durationMs);

      if (item.status === 'SUCCESS') {
        successCount++;
        breakdown.NONE++;
      } else {
        failureCount++;
        const cat = item.failureCategory || 'UNEXPECTED';
        breakdown[cat] = (breakdown[cat] || 0) + 1;

        if (item.failedStepId) {
          stepFailureMap.set(item.failedStepId, (stepFailureMap.get(item.failedStepId) || 0) + 1);
        }
      }

      totalRecoveries += item.recoveryAttempts || 0;
    }

    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const medianDurationMs = durations.length % 2 === 0
      ? (durations[mid - 1] + durations[mid]) / 2
      : durations[mid];

    const frequentFailingSteps = Array.from(stepFailureMap.entries())
      .map(([stepId, count]) => ({ stepId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalRuns: history.length,
      successCount,
      failureCount,
      successRate: Math.round((successCount / history.length) * 100),
      averageDurationMs: Math.round(totalDuration / history.length),
      medianDurationMs: Math.round(medianDurationMs),
      failureBreakdown: breakdown,
      frequentFailingSteps,
      recoveryFrequency: totalRecoveries,
    };
  }

  /**
   * Clears history
   */
  static async clearHistory(workflowId?: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

    if (!workflowId) {
      await chrome.storage.local.remove(STORAGE_KEYS.EXECUTION_HISTORY);
    } else {
      const all = await this.getHistory();
      const retained = all.filter((e) => e.workflowId !== workflowId);
      await chrome.storage.local.set({ [STORAGE_KEYS.EXECUTION_HISTORY]: retained });
    }
  }
}
