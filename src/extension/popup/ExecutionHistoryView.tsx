import React, { useState, useEffect } from 'react';
import type { ExecutionHistoryEntry, ExecutionAnalytics } from '../../automation/history/history-types';
import { ExecutionHistoryManager } from '../../automation/history/ExecutionHistoryManager';

export const ExecutionHistoryView: React.FC = () => {
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [analytics, setAnalytics] = useState<ExecutionAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = React.useCallback(async () => {
    try {
      const [hist, anal] = await Promise.all([
        ExecutionHistoryManager.getHistory(),
        ExecutionHistoryManager.getAnalytics(),
      ]);
      setHistory(hist);
      setAnalytics(anal);
    } catch (err) {
      console.error('Failed to load execution history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      ExecutionHistoryManager.getHistory(),
      ExecutionHistoryManager.getAnalytics(),
    ]).then(([hist, anal]) => {
      if (!active) return;
      setHistory(hist);
      setAnalytics(anal);
      setLoading(false);
    }).catch((err) => {
      console.error('Failed to load execution history:', err);
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleClear = async () => {
    if (window.confirm('Clear all execution history and analytics?')) {
      await ExecutionHistoryManager.clearHistory();
      await loadData();
    }
  };

  return (
    <div className="w-full flex flex-col space-y-3 text-xs text-[#CDE4E6]">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-[#F9DF9F] flex items-center gap-1.5">
          <span>📊</span> Replay Analytics & History
        </h3>
        {history.length > 0 && (
          <button
            onClick={handleClear}
            className="text-[10px] text-red-400 hover:text-red-300 font-semibold"
          >
            Clear History
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">Loading history...</div>
      ) : (
        <>
          {/* Analytics Overview Cards */}
          {analytics && analytics.totalRuns > 0 && (
            <div className="grid grid-cols-4 gap-1.5 p-2 rounded-lg bg-[#1A2240] border border-[#CDE4E6]/10 text-center">
              <div className="p-1">
                <span className="block text-[9px] uppercase text-[#CDE4E6]/50">Total</span>
                <span className="font-bold text-sm text-[#F9DF9F]">{analytics.totalRuns}</span>
              </div>
              <div className="p-1">
                <span className="block text-[9px] uppercase text-[#CDE4E6]/50">Success</span>
                <span className="font-bold text-sm text-emerald-400">{analytics.successRate}%</span>
              </div>
              <div className="p-1">
                <span className="block text-[9px] uppercase text-[#CDE4E6]/50">Avg Time</span>
                <span className="font-bold text-sm text-[#38bdf8]">
                  {(analytics.averageDurationMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="p-1">
                <span className="block text-[9px] uppercase text-[#CDE4E6]/50">Median</span>
                <span className="font-bold text-sm text-purple-300">
                  {(analytics.medianDurationMs / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          )}

          {/* Failure Breakdown If Failures Occurred */}
          {analytics && analytics.failureCount > 0 && (
            <div className="p-2 rounded bg-red-950/20 border border-red-500/20 space-y-1">
              <span className="text-[10px] font-bold text-red-300 uppercase block">
                Failure Diagnostic Distribution
              </span>
              <div className="flex flex-wrap gap-2 text-[10px] text-[#CDE4E6]/80">
                {Object.entries(analytics.failureBreakdown).map(([cat, count]) => {
                  if (count === 0 || cat === 'NONE') return null;
                  return (
                    <span key={cat} className="px-1.5 py-0.5 rounded bg-black/30 font-mono">
                      {cat}: <strong className="text-red-400">{count}</strong>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Execution History Timeline */}
          {history.length === 0 ? (
            <div className="py-8 text-center text-[#CDE4E6]/50">
              No executions recorded yet. Play a workflow to generate performance metrics.
            </div>
          ) : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="p-2.5 rounded-lg bg-[#1A2240] border border-[#CDE4E6]/10 flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-[#F9DF9F] truncate max-w-[170px]">
                      {item.workflowName}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        item.status === 'SUCCESS'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30'
                          : item.status === 'RECOVERY_REQUIRED'
                          ? 'bg-amber-950 text-amber-400 border border-amber-500/30'
                          : 'bg-red-950 text-red-400 border border-red-500/30'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-[#CDE4E6]/60">
                    <span>{new Date(item.startTime).toLocaleTimeString()}</span>
                    <span>
                      Duration: <strong className="text-white">{(item.durationMs / 1000).toFixed(2)}s</strong>
                    </span>
                    <span>
                      Steps: <strong className="text-white">{item.executedSteps}/{item.totalSteps}</strong>
                    </span>
                  </div>

                  {item.failureReason && (
                    <p className="text-[10px] text-red-300 bg-red-950/40 p-1.5 rounded font-mono truncate">
                      ⚠️ {item.failureReason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
