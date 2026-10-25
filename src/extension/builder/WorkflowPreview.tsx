import React, { useState, useMemo } from 'react';
import type { Workflow, WorkflowStep } from '../../shared/types/workflow';
import { validateWorkflowGraph } from '../../workflow/storage/schema';

interface WorkflowPreviewProps {
  workflow: Workflow;
  onClose: () => void;
}

export const WorkflowPreview: React.FC<WorkflowPreviewProps> = ({ workflow, onClose }) => {
  const [mockVariables, setMockVariables] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    (workflow.variables || []).forEach((v) => {
      initial[v.name] = v.defaultValue ?? '';
    });
    return initial;
  });

  const [conditionOverrides, setConditionOverrides] = useState<Record<string, boolean>>({});

  // Compute simulated dry-run execution path (Pure in-memory, ZERO browser calls)
  const simulation = useMemo(() => {
    const graphValidation = validateWorkflowGraph(workflow);
    const steps = workflow.steps || [];
    const stepMap = new Map<string, WorkflowStep>();
    steps.forEach((s) => stepMap.set(s.id, s));

    const path: { step: WorkflowStep; stepIndex: number; branchTaken?: 'true' | 'false' }[] = [];
    const visited = new Set<string>();
    let currentId = steps[0]?.id;
    let stepBudget = Math.min(100, steps.length * 5);
    let cycleDetected = false;

    while (currentId && stepBudget > 0) {
      stepBudget--;
      const step = stepMap.get(currentId);
      if (!step) break;

      const idx = steps.findIndex((s) => s.id === currentId);

      if (visited.has(currentId)) {
        cycleDetected = true;
      }
      visited.add(currentId);

      if (step.condition) {
        // Determine branch based on manual override or variable mock
        let branchResult = conditionOverrides[step.id];
        if (branchResult === undefined) {
          if (step.condition.source === 'variable' && step.condition.name) {
            const currentVal = mockVariables[step.condition.name];
            branchResult = String(currentVal) === String(step.condition.value ?? '');
          } else {
            branchResult = true; // Default preview branch
          }
        }

        path.push({
          step,
          stepIndex: idx,
          branchTaken: branchResult ? 'true' : 'false',
        });

        const target = branchResult ? step.condition.onTrue : step.condition.onFalse;
        if (!target || target === 'end') {
          break;
        } else if (target === 'next') {
          currentId = steps[idx + 1]?.id;
        } else {
          currentId = target;
        }
      } else {
        path.push({
          step,
          stepIndex: idx,
        });
        currentId = steps[idx + 1]?.id;
      }
    }

    return {
      path,
      cycleDetected,
      graphValidation,
      budgetExceeded: stepBudget <= 0,
    };
  }, [workflow, mockVariables, conditionOverrides]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#1A2240] border border-[#F9DF9F]/30 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col text-[#CDE4E6] overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 bg-[#263056] border-b border-[#F9DF9F]/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">👁️</span>
            <div>
              <h3 className="font-bold text-sm text-[#F9DF9F]">Workflow Dry-Run Preview</h3>
              <p className="text-[11px] text-[#CDE4E6]/70">
                Safe offline graph simulation. <strong>No browser interactions or web mutations are dispatched.</strong>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-lg font-bold"
          >
            ×
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Status Badges */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="px-2.5 py-1 rounded-full bg-emerald-950 text-emerald-300 font-semibold text-[11px] border border-emerald-500/30">
              ✓ Offline Mode (Safe)
            </span>
            <span className="px-2.5 py-1 rounded-full bg-[#263056] text-[#CDE4E6] text-[11px]">
              Expected Steps: {simulation.path.length} / {workflow.steps.length}
            </span>
            {simulation.cycleDetected && (
              <span className="px-2.5 py-1 rounded-full bg-amber-950 text-amber-300 text-[11px] font-semibold">
                ⚠️ Graph Contains Loop / Cycle
              </span>
            )}
            {simulation.graphValidation.unreachableStepIds.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-amber-950 text-amber-300 text-[11px]">
                {simulation.graphValidation.unreachableStepIds.length} Unreachable Step(s)
              </span>
            )}
          </div>

          {/* Mock Variable Inputs */}
          {(workflow.variables || []).length > 0 && (
            <div className="p-3 bg-[#263056]/50 rounded-lg border border-[#CDE4E6]/10 space-y-2">
              <span className="font-bold text-[11px] text-[#F9DF9F] uppercase tracking-wider block">
                Simulated Runtime Variables
              </span>
              <div className="grid grid-cols-2 gap-2">
                {workflow.variables.map((v) => (
                  <div key={v.name}>
                    <label className="block text-[10px] text-[#CDE4E6]/70 mb-0.5 truncate">{v.name}</label>
                    <input
                      type="text"
                      value={mockVariables[v.name] ?? ''}
                      onChange={(e) =>
                        setMockVariables((prev) => ({ ...prev, [v.name]: e.target.value }))
                      }
                      className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs text-[#CDE4E6] outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Simulated Execution Trail */}
          <div className="space-y-2">
            <span className="font-bold text-[11px] text-[#F9DF9F] uppercase tracking-wider block">
              Simulated Execution Path
            </span>

            {simulation.path.length === 0 ? (
              <div className="text-center py-6 text-[#CDE4E6]/50">No steps in workflow</div>
            ) : (
              <div className="space-y-2">
                {simulation.path.map((item, idx) => (
                  <div
                    key={`${item.step.id}_${idx}`}
                    className="p-2.5 rounded-lg bg-[#263056] border border-[#CDE4E6]/15 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-5 h-5 rounded-full bg-black/40 text-[10px] flex items-center justify-center font-bold text-[#F9DF9F]">
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-xs uppercase text-[#CDE4E6]">
                            {item.step.type}
                          </span>
                          {item.step.description && (
                            <span className="text-[11px] text-[#CDE4E6]/70 truncate">
                              — {item.step.description}
                            </span>
                          )}
                        </div>
                        {item.step.url && (
                          <p className="text-[10px] font-mono text-[#CDE4E6]/50 truncate">{item.step.url}</p>
                        )}
                      </div>
                    </div>

                    {item.step.condition && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] text-[#CDE4E6]/60">Branch:</span>
                        <button
                          onClick={() =>
                            setConditionOverrides((prev) => ({
                              ...prev,
                              [item.step.id]: !(prev[item.step.id] ?? (item.branchTaken === 'true')),
                            }))
                          }
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            item.branchTaken === 'true'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30'
                              : 'bg-amber-950 text-amber-400 border border-amber-500/30'
                          }`}
                          title="Click to toggle branch in preview"
                        >
                          {item.branchTaken?.toUpperCase()} (Toggle)
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                <div className="p-2 text-center text-[11px] text-emerald-400 bg-emerald-950/30 rounded border border-emerald-500/20">
                  🏁 Workflow Terminated Successfully (End of Path)
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3 bg-[#263056] border-t border-[#F9DF9F]/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#F9DF9F] text-[#263056] font-bold rounded hover:bg-[#e6cc8e] transition-colors"
          >
            Close Preview
          </button>
        </div>
      </div>
    </div>
  );
};
