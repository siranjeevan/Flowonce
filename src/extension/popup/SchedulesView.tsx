import React, { useState, useEffect } from 'react';
import type { WorkflowSchedule } from '../../automation/scheduler/scheduler-types';
import { ScheduleManager } from '../../automation/scheduler/ScheduleManager';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import type { Workflow } from '../../shared/types/workflow';
import { classifyActionSafety } from '../../replay/ActionVerifier';

export const SchedulesView: React.FC = () => {
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Form State
  const [selectedWfId, setSelectedWfId] = useState('');
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleType, setScheduleType] = useState<'once' | 'interval' | 'daily'>('interval');
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [dailyTime, setDailyTime] = useState('09:00');
  const [forceUnsafeAuthorization, setForceUnsafeAuthorization] = useState(false);

  const loadData = React.useCallback(async () => {
    try {
      const [schedList, wfList] = await Promise.all([
        ScheduleManager.getAllSchedules(),
        WorkflowStorage.getAllWorkflows(),
      ]);
      setSchedules(schedList);
      setWorkflows(wfList);
      if (wfList.length > 0) {
        setSelectedWfId((prev) => prev || wfList[0].id);
      }
    } catch (err) {
      console.error('Failed to load schedules:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      ScheduleManager.getAllSchedules(),
      WorkflowStorage.getAllWorkflows(),
    ]).then(([schedList, wfList]) => {
      if (!active) return;
      setSchedules(schedList);
      setWorkflows(wfList);
      if (wfList.length > 0) {
        setSelectedWfId((prev) => prev || wfList[0].id);
      }
      setLoading(false);
    }).catch((err) => {
      console.error('Failed to load schedules:', err);
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleToggle = async (schedule: WorkflowSchedule) => {
    try {
      await ScheduleManager.toggleSchedule(schedule.id, !schedule.enabled);
      await loadData();
    } catch (err: any) {
      alert(`Error toggling schedule: ${err.message}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Delete this schedule?')) {
      await ScheduleManager.deleteSchedule(id);
      await loadData();
    }
  };

  const selectedWf = workflows.find((w) => w.id === selectedWfId);
  const targetHasSideEffects = selectedWf?.steps.some((s) => {
    const cat = classifyActionSafety(s);
    return cat === 'EXTERNAL_SIDE_EFFECT' || cat === 'TOGGLE_STATE';
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWf) return;

    const newSchedule: WorkflowSchedule = {
      id: `sched_${Date.now().toString(36)}`,
      workflowId: selectedWf.id,
      workflowName: selectedWf.name,
      name: scheduleName.trim() || `${selectedWf.name} Schedule`,
      enabled: true,
      type: scheduleType,
      intervalMinutes: scheduleType === 'interval' ? Number(intervalMinutes) : undefined,
      dailyTime: scheduleType === 'daily' ? dailyTime : undefined,
      scheduledTime: scheduleType === 'once' ? Date.now() + 60000 : undefined,
      forceUnsafeAuthorization: targetHasSideEffects ? forceUnsafeAuthorization : false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await ScheduleManager.saveSchedule(newSchedule);
      setShowCreateModal(false);
      setScheduleName('');
      setForceUnsafeAuthorization(false);
      await loadData();
    } catch (err: any) {
      alert(`Failed to save schedule: ${err.message}`);
    }
  };

  return (
    <div className="w-full flex flex-col space-y-3 text-xs text-[#CDE4E6]">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-[#F9DF9F] flex items-center gap-1.5">
          <span>⏰</span> Scheduled Replays
        </h3>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-2.5 py-1 rounded bg-[#F9DF9F] text-[#263056] font-bold text-[11px] hover:bg-[#e6cc8e] shadow-sm"
        >
          + New Schedule
        </button>
      </div>

      {/* Chrome MV3 Lifecycle Notice */}
      <div className="p-2 rounded bg-[#1A2240] border border-[#CDE4E6]/10 text-[10px] text-[#CDE4E6]/70 leading-relaxed">
        ℹ️ Uses <code>chrome.alarms</code>. Scheduled triggers operate while Chrome is running. Any pending triggers scheduled while the browser was closed will execute automatically upon restart.
      </div>

      {loading ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">Loading schedules...</div>
      ) : schedules.length === 0 ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">
          No schedules configured. Click "+ New Schedule" to automate your workflows.
        </div>
      ) : (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {schedules.map((s) => (
            <div
              key={s.id}
              className="p-3 rounded-lg bg-[#1A2240] border border-[#CDE4E6]/10 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-bold text-xs text-[#F9DF9F]">{s.name}</h4>
                  <p className="text-[10px] text-[#CDE4E6]/70">Target: {s.workflowName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(s)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      s.enabled ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-white/5 text-[#CDE4E6]/40'
                    }`}
                  >
                    {s.enabled ? 'ENABLED' : 'PAUSED'}
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="text-red-400 hover:text-red-300 text-xs px-1"
                    title="Delete schedule"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[10px] text-[#CDE4E6]/60 bg-[#263056]/50 p-1.5 rounded">
                <div>
                  <span className="block text-[9px] uppercase font-bold text-[#CDE4E6]/40">Cadence</span>
                  <span className="text-[#CDE4E6] capitalize">
                    {s.type === 'interval'
                      ? `Every ${s.intervalMinutes}m`
                      : s.type === 'daily'
                      ? `Daily at ${s.dailyTime}`
                      : 'One-time run'}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase font-bold text-[#CDE4E6]/40">Last Status</span>
                  <span
                    className={`font-semibold ${
                      s.lastStatus === 'SUCCESS'
                        ? 'text-emerald-400'
                        : s.lastStatus === 'REFUSED_SIDE_EFFECT'
                        ? 'text-amber-400'
                        : s.lastStatus === 'FAILED'
                        ? 'text-red-400'
                        : 'text-[#CDE4E6]/60'
                    }`}
                  >
                    {s.lastStatus || 'Never run'}
                  </span>
                </div>
              </div>

              {s.lastErrorMessage && (
                <p className="text-[10px] text-red-400 bg-red-950/30 p-1 rounded font-mono truncate">
                  ⚠️ {s.lastErrorMessage}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Schedule Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
          <form
            onSubmit={handleCreate}
            className="bg-[#1A2240] border border-[#F9DF9F]/30 rounded-xl p-4 max-w-sm w-full space-y-3 text-xs text-[#CDE4E6]"
          >
            <div className="flex items-center justify-between border-b border-[#F9DF9F]/10 pb-2">
              <h4 className="font-bold text-sm text-[#F9DF9F]">Create Automation Schedule</h4>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Target Workflow
              </label>
              <select
                value={selectedWfId}
                onChange={(e) => setSelectedWfId(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              >
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name} ({wf.steps.length} steps)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Schedule Name
              </label>
              <input
                type="text"
                value={scheduleName}
                onChange={(e) => setScheduleName(e.target.value)}
                placeholder="e.g. Daily Inventory Check"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Frequency
              </label>
              <select
                value={scheduleType}
                onChange={(e) => setScheduleType(e.target.value as any)}
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              >
                <option value="interval">Repeat on Interval</option>
                <option value="daily">Daily at Specific Time</option>
                <option value="once">Run Once</option>
              </select>
            </div>

            {scheduleType === 'interval' && (
              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Interval (Minutes)</label>
                <input
                  type="number"
                  min="5"
                  max="1440"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(parseInt(e.target.value, 10) || 15)}
                  className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                />
              </div>
            )}

            {scheduleType === 'daily' && (
              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Time (24h format)</label>
                <input
                  type="time"
                  value={dailyTime}
                  onChange={(e) => setDailyTime(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                />
              </div>
            )}

            {/* Side-Effect Safety Gate Alert */}
            {targetHasSideEffects && (
              <div className="p-2.5 rounded bg-amber-950/50 border border-amber-500/40 space-y-2">
                <span className="font-bold text-[10px] text-amber-300 uppercase block">
                  ⚠️ Side-Effect Safety Gate
                </span>
                <p className="text-[10px] text-amber-200/90 leading-tight">
                  This workflow contains actions that modify external system state (e.g., clicks, state toggles, or data submissions).
                </p>
                <label className="flex items-start gap-2 cursor-pointer text-[10px] font-semibold text-amber-300">
                  <input
                    type="checkbox"
                    checked={forceUnsafeAuthorization}
                    onChange={(e) => setForceUnsafeAuthorization(e.target.checked)}
                    className="mt-0.5 rounded text-amber-500"
                  />
                  <span>I authorize unattended automated execution of this side-effecting workflow.</span>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-[#F9DF9F]/10">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 rounded bg-[#263056] font-semibold text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-[#F9DF9F] text-[#263056] font-bold text-xs"
              >
                Save Schedule
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
