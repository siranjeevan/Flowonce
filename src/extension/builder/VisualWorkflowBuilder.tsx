import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { Workflow, WorkflowStep, ActionType } from '../../shared/types/workflow';
import { StepPalette } from './StepPalette';
import { WorkflowCanvas } from './WorkflowCanvas';
import { PropertiesInspector } from './PropertiesInspector';
import { WorkflowPreview } from './WorkflowPreview';
import { validateWorkflow, validateWorkflowGraph } from '../../workflow/storage/schema';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { CollaborationManager } from '../../collaboration/CollaborationManager';

interface VisualWorkflowBuilderProps {
  initialWorkflow: Workflow;
  onSave?: (savedWorkflow: Workflow) => void;
  onClose?: () => void;
  currentUserId?: string;
}

export const VisualWorkflowBuilder: React.FC<VisualWorkflowBuilderProps> = ({
  initialWorkflow,
  onSave,
  onClose,
  currentUserId,
}) => {
  const [workflow, setWorkflow] = useState<Workflow>(() => JSON.parse(JSON.stringify(initialWorkflow)));
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showValidationDrawer, setShowValidationDrawer] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Undo / Redo History Stack (Bounded to 50 states)
  const [history, setHistory] = useState<WorkflowStep[][]>([initialWorkflow.steps || []]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const pushHistory = useCallback(
    (newSteps: WorkflowStep[]) => {
      const nextHistory = history.slice(0, historyIndex + 1);
      nextHistory.push(JSON.parse(JSON.stringify(newSteps)));
      if (nextHistory.length > 50) {
        nextHistory.shift();
      }
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length - 1);
      setHasUnsavedChanges(true);
    },
    [history, historyIndex]
  );

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const targetIndex = historyIndex - 1;
      const targetSteps = JSON.parse(JSON.stringify(history[targetIndex]));
      setWorkflow((prev) => ({ ...prev, steps: targetSteps }));
      setHistoryIndex(targetIndex);
      setHasUnsavedChanges(true);
    }
  }, [historyIndex, history]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const targetIndex = historyIndex + 1;
      const targetSteps = JSON.parse(JSON.stringify(history[targetIndex]));
      setWorkflow((prev) => ({ ...prev, steps: targetSteps }));
      setHistoryIndex(targetIndex);
      setHasUnsavedChanges(true);
    }
  }, [historyIndex, history]);

  // Delete step
  const handleDeleteStep = useCallback((stepId: string) => {
    setWorkflow((prev) => {
      const filtered = prev.steps.filter((s) => s.id !== stepId);
      // Clean up sequence indices and references to the deleted step
      const cleaned = filtered.map((s, idx) => {
        const next: WorkflowStep = { ...s, sequence: idx };
        if (next.condition) {
          if (next.condition.onTrue === stepId) next.condition.onTrue = 'next';
          if (next.condition.onFalse === stepId) next.condition.onFalse = 'end';
        }
        return next;
      });
      pushHistory(cleaned);
      return { ...prev, steps: cleaned };
    });
    setSelectedStepId((curr) => (curr === stepId ? null : curr));
  }, [pushHistory]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if active element is an input or textarea
      const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        handleRedo();
        e.preventDefault();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedStepId) {
          handleDeleteStep(selectedStepId);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        setSelectedStepId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, selectedStepId, handleDeleteStep]);

  // Validation calculations
  const validation = useMemo(() => {
    const schemaValidation = validateWorkflow(workflow);
    const graphValidation = validateWorkflowGraph(workflow);

    const stepErrors: Record<string, string[]> = {};
    schemaValidation.errors.forEach((err) => {
      if (err.stepIndex !== undefined && workflow.steps[err.stepIndex]) {
        const stepId = workflow.steps[err.stepIndex].id;
        stepErrors[stepId] = stepErrors[stepId] || [];
        stepErrors[stepId].push(err.message);
      }
    });

    graphValidation.errors.forEach((err) => {
      if (err.stepIndex !== undefined && workflow.steps[err.stepIndex]) {
        const stepId = workflow.steps[err.stepIndex].id;
        stepErrors[stepId] = stepErrors[stepId] || [];
        stepErrors[stepId].push(err.message);
      } else {
        workflow.steps.forEach((s) => {
          if (err.message.includes(s.id)) {
            stepErrors[s.id] = stepErrors[s.id] || [];
            stepErrors[s.id].push(err.message);
          }
        });
      }
    });

    return {
      isValid: schemaValidation.valid && graphValidation.valid,
      errors: [
        ...schemaValidation.errors.map((e) => e.message),
        ...graphValidation.errors.map((e) => e.message),
      ],
      warnings: [...graphValidation.warnings],
      stepErrors,
      unreachableStepIds: graphValidation.unreachableStepIds,
      hasCycle: graphValidation.hasCycle,
    };
  }, [workflow]);

  // Add Step from Palette
  const handleAddStep = (type: ActionType, componentId?: string) => {
    const newId = `step_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const stepCount = workflow.steps.length;

    // Calculate layout coordinates so nodes don't overlap
    const lastStep = workflow.steps[stepCount - 1];
    const x = lastStep?.layout ? lastStep.layout.x + (type === 'condition' ? 80 : 0) : 100;
    const y = lastStep?.layout ? lastStep.layout.y + 140 : 100 + stepCount * 140;

    const newStep: WorkflowStep = {
      id: newId,
      type,
      timestamp: Date.now(),
      url: lastStep?.url || 'https://example.com',
      sequence: stepCount,
      description: componentId ? `Invoke Component (${componentId})` : `Step ${stepCount + 1}`,
      componentId,
      layout: { x, y },
    };

    if (type === 'condition') {
      newStep.condition = {
        source: 'variable',
        name: 'status',
        operator: 'equals',
        value: 'success',
        onTrue: 'next',
        onFalse: 'end',
      };
    } else if (type === 'extract') {
      newStep.extraction = {
        id: `ext_${Date.now().toString(36)}`,
        type: 'inner_text',
        variableName: `output_${stepCount + 1}`,
      };
    }

    const updatedSteps = [...workflow.steps, newStep];
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps }));
    pushHistory(updatedSteps);
    setSelectedStepId(newId);
  };

  // Update layout coordinates (dragging on canvas)
  const handleUpdateStepLayout = (stepId: string, x: number, y: number) => {
    setWorkflow((prev) => {
      const updatedSteps = prev.steps.map((s) => (s.id === stepId ? { ...s, layout: { x, y } } : s));
      return { ...prev, steps: updatedSteps };
    });
    setHasUnsavedChanges(true);
  };

  // Connect steps on canvas
  const handleConnectSteps = (
    fromStepId: string,
    toStepId: string,
    branch: 'next' | 'true' | 'false'
  ) => {
    setWorkflow((prev) => {
      const updatedSteps = prev.steps.map((s) => {
        if (s.id !== fromStepId) return s;
        if (branch === 'true' && s.condition) {
          return { ...s, condition: { ...s.condition, onTrue: toStepId } };
        }
        if (branch === 'false' && s.condition) {
          return { ...s, condition: { ...s.condition, onFalse: toStepId } };
        }
        return s;
      });
      pushHistory(updatedSteps);
      return { ...prev, steps: updatedSteps };
    });
  };

  // Update step properties from inspector
  const handleUpdateStep = (updated: WorkflowStep) => {
    setWorkflow((prev) => {
      const updatedSteps = prev.steps.map((s) => (s.id === updated.id ? updated : s));
      pushHistory(updatedSteps);
      return { ...prev, steps: updatedSteps };
    });
  };

  // Duplicate step
  const handleDuplicateStep = (stepId: string) => {
    const target = workflow.steps.find((s) => s.id === stepId);
    if (!target) return;

    const cloned: WorkflowStep = JSON.parse(JSON.stringify(target));
    cloned.id = `step_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    cloned.description = `${target.description || target.type} (Copy)`;
    if (cloned.layout) {
      cloned.layout = { x: cloned.layout.x + 30, y: cloned.layout.y + 30 };
    }

    const updatedSteps = [...workflow.steps, cloned];
    setWorkflow((prev) => ({ ...prev, steps: updatedSteps }));
    pushHistory(updatedSteps);
    setSelectedStepId(cloned.id);
  };

  // Move step up or down
  const handleMoveStep = (stepId: string, direction: 'up' | 'down') => {
    const idx = workflow.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === workflow.steps.length - 1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    const reordered = [...workflow.steps];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(targetIdx, 0, moved);

    // Re-index sequences
    const cleaned = reordered.map((s, i) => ({ ...s, sequence: i }));
    setWorkflow((prev) => ({ ...prev, steps: cleaned }));
    pushHistory(cleaned);
  };

  // Save changes
  const handleSave = async () => {
    // Check collaboration role permissions
    const perm = CollaborationManager.canUserPerform(workflow, currentUserId, 'edit');
    if (!perm.allowed) {
      alert(perm.reason);
      return;
    }

    // Check conflict against base revision
    const existing = await WorkflowStorage.getWorkflow(workflow.id);
    if (existing) {
      const conflict = CollaborationManager.checkRevisionConflict(existing, initialWorkflow.version || 1);
      if (conflict.hasConflict) {
        alert(conflict.message);
        return;
      }
    }

    const toSave: Workflow = {
      ...workflow,
      version: (workflow.version || 1) + 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      await WorkflowStorage.createWorkflow(toSave);
      setWorkflow(toSave);
      setHasUnsavedChanges(false);
      setStatusMessage('Workflow saved successfully!');
      setTimeout(() => setStatusMessage(null), 3000);
      onSave?.(toSave);
    } catch (err: any) {
      alert(`Failed to save workflow: ${err.message}`);
    }
  };

  // Discard changes
  const handleDiscard = () => {
    if (window.confirm('Discard all unsaved changes and reload original workflow?')) {
      const reverted = JSON.parse(JSON.stringify(initialWorkflow));
      setWorkflow(reverted);
      setHistory([reverted.steps || []]);
      setHistoryIndex(0);
      setHasUnsavedChanges(false);
    }
  };

  // Open builder in dedicated full Chrome tab
  const handleOpenInFullTab = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const url = chrome.runtime.getURL(`index.html?view=builder&workflowId=${encodeURIComponent(workflow.id)}`);
      chrome.tabs.create({ url });
    }
  };

  const selectedStep = workflow.steps.find((s) => s.id === selectedStepId) || null;

  return (
    <div className="flex flex-col w-full h-screen bg-[#1e2642] text-[#CDE4E6] font-sans overflow-hidden">
      {/* Top Header Bar */}
      <header className="h-12 bg-[#263056] border-b border-[#F9DF9F]/20 px-3 flex items-center justify-between select-none shrink-0 z-30">
        <div className="flex items-center gap-3 min-w-0">
          {onClose && (
            <button
              onClick={onClose}
              className="text-[#CDE4E6] hover:text-[#F9DF9F] p-1.5 rounded hover:bg-white/10 text-xs font-bold"
              title="Return to Workflows"
            >
              ← Back
            </button>
          )}

          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base">🛠️</span>
            <input
              type="text"
              value={workflow.name}
              onChange={(e) => {
                setWorkflow((p) => ({ ...p, name: e.target.value }));
                setHasUnsavedChanges(true);
              }}
              className="font-bold text-sm bg-transparent border-b border-transparent hover:border-[#F9DF9F]/40 focus:border-[#F9DF9F] focus:bg-[#1A2240] px-1.5 py-0.5 rounded text-[#F9DF9F] outline-none truncate w-56"
              placeholder="Workflow Name"
            />
          </div>

          {hasUnsavedChanges && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950 text-amber-300 border border-amber-500/30 font-semibold animate-pulse">
              ● Unsaved
            </span>
          )}

          {statusMessage && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 font-semibold">
              ✓ {statusMessage}
            </span>
          )}
        </div>

        {/* Center / Right Action Controls */}
        <div className="flex items-center gap-2">
          {/* Undo / Redo */}
          <div className="flex items-center bg-[#1A2240] rounded border border-[#CDE4E6]/20 p-0.5">
            <button
              onClick={handleUndo}
              disabled={historyIndex <= 0}
              className="px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent rounded font-bold"
              title="Undo (Ctrl+Z)"
            >
              ↩
            </button>
            <div className="w-[1px] h-3 bg-[#CDE4E6]/20 mx-0.5" />
            <button
              onClick={handleRedo}
              disabled={historyIndex >= history.length - 1}
              className="px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent rounded font-bold"
              title="Redo (Ctrl+Y)"
            >
              ↪
            </button>
          </div>

          {/* Validation Drawer Toggle */}
          <button
            onClick={() => setShowValidationDrawer((p) => !p)}
            className={`px-2.5 py-1 text-xs font-semibold rounded border flex items-center gap-1.5 transition-colors ${
              !validation.isValid
                ? 'bg-red-950 text-red-300 border-red-500/50'
                : validation.warnings.length > 0
                ? 'bg-amber-950 text-amber-300 border-amber-500/40'
                : 'bg-[#1A2240] text-emerald-400 border-emerald-500/30'
            }`}
          >
            <span>{validation.isValid ? '✓' : '⚠️'}</span>
            <span>
              {!validation.isValid
                ? `${validation.errors.length} Errors`
                : validation.warnings.length > 0
                ? `${validation.warnings.length} Warnings`
                : 'Valid'}
            </span>
          </button>

          {/* Dry Run Preview Mode */}
          <button
            onClick={() => setShowPreview(true)}
            className="px-3 py-1 text-xs font-bold bg-[#1A2240] text-[#38bdf8] hover:bg-[#38bdf8]/20 border border-[#38bdf8]/40 rounded shadow-sm flex items-center gap-1"
            title="Simulate offline execution path without browser interactions"
          >
            <span>👁️</span> Preview
          </button>

          {/* Popout Full Tab */}
          <button
            onClick={handleOpenInFullTab}
            className="px-2.5 py-1 text-xs font-semibold bg-[#1A2240] text-[#CDE4E6] hover:bg-white/10 border border-[#CDE4E6]/20 rounded"
            title="Expand to Full Desktop Window"
          >
            ↗ Expand
          </button>

          {/* Discard & Save */}
          {hasUnsavedChanges && (
            <button
              onClick={handleDiscard}
              className="px-2.5 py-1 text-xs font-semibold bg-[#1A2240] hover:bg-white/10 text-[#CDE4E6]/70 hover:text-white rounded border border-[#CDE4E6]/20"
            >
              Discard
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={!validation.isValid}
            className="px-3.5 py-1 text-xs font-bold bg-[#F9DF9F] hover:bg-[#e6cc8e] disabled:opacity-40 text-[#263056] rounded shadow-sm transition-colors"
          >
            Save Workflow
          </button>
        </div>
      </header>

      {/* Main Builder Area: Palette | Canvas | Inspector */}
      <div className="flex-1 flex overflow-hidden relative">
        <StepPalette onAddStep={handleAddStep} />

        <WorkflowCanvas
          steps={workflow.steps}
          selectedStepId={selectedStepId}
          onSelectStep={setSelectedStepId}
          onUpdateStepLayout={handleUpdateStepLayout}
          onConnectSteps={handleConnectSteps}
          onDeleteStep={handleDeleteStep}
          validationErrors={validation.stepErrors}
          unreachableStepIds={validation.unreachableStepIds}
        />

        <PropertiesInspector
          step={selectedStep}
          allSteps={workflow.steps}
          onUpdateStep={handleUpdateStep}
          onDuplicateStep={handleDuplicateStep}
          onDeleteStep={handleDeleteStep}
          onMoveStep={handleMoveStep}
        />
      </div>

      {/* Bottom Validation / Diagnostic Drawer */}
      {showValidationDrawer && (
        <div className="h-44 bg-[#1A2240] border-t border-[#F9DF9F]/20 p-3 flex flex-col shrink-0 z-20 text-xs">
          <div className="flex items-center justify-between pb-2 border-b border-[#F9DF9F]/10">
            <h4 className="font-bold text-xs uppercase text-[#F9DF9F] flex items-center gap-2">
              <span>Workflow Diagnostics & Graph Validation</span>
              <span className="text-[10px] text-[#CDE4E6]/50">
                ({validation.errors.length} errors, {validation.warnings.length} warnings)
              </span>
            </h4>
            <button
              onClick={() => setShowValidationDrawer(false)}
              className="text-[#CDE4E6]/60 hover:text-white font-bold"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 py-2">
            {validation.errors.length === 0 && validation.warnings.length === 0 ? (
              <p className="text-emerald-400 text-xs py-2">✓ No issues detected. Workflow graph is fully consistent!</p>
            ) : (
              <>
                {validation.errors.map((err, i) => (
                  <div
                    key={`err_${i}`}
                    className="p-1.5 rounded bg-red-950/50 border border-red-500/30 text-red-300 text-[11px] flex items-center justify-between"
                  >
                    <span>❌ {err}</span>
                  </div>
                ))}
                {validation.warnings.map((warn, i) => (
                  <div
                    key={`warn_${i}`}
                    className="p-1.5 rounded bg-amber-950/40 border border-amber-500/20 text-amber-300 text-[11px]"
                  >
                    <span>⚠️ {warn}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Dry Run Preview Simulator Modal */}
      {showPreview && (
        <WorkflowPreview workflow={workflow} onClose={() => setShowPreview(false)} />
      )}
    </div>
  );
};
