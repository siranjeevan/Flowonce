import React, { useState } from 'react';
import type { WorkflowStep, ActionType } from '../../shared/types/workflow';
import { isSafeUrl } from '../../workflow/storage/schema';

interface PropertiesInspectorProps {
  step: WorkflowStep | null;
  allSteps: WorkflowStep[];
  onUpdateStep: (updated: WorkflowStep) => void;
  onDuplicateStep: (stepId: string) => void;
  onDeleteStep: (stepId: string) => void;
  onMoveStep: (stepId: string, direction: 'up' | 'down') => void;
}

export const PropertiesInspector: React.FC<PropertiesInspectorProps> = ({
  step,
  allSteps,
  onUpdateStep,
  onDuplicateStep,
  onDeleteStep,
  onMoveStep,
}) => {
  const [activeTab, setActiveTab] = useState<'action' | 'target' | 'verification' | 'logic'>('action');
  const [showSensitive, setShowSensitive] = useState(false);

  if (!step) {
    return (
      <div className="w-80 bg-[#1A2240] border-l border-[#F9DF9F]/20 p-4 flex flex-col justify-center items-center text-center text-[#CDE4E6]/50 text-xs">
        <span className="text-3xl mb-2">🎯</span>
        <p className="font-semibold text-[#CDE4E6]">No Step Selected</p>
        <p className="text-[11px] mt-1 text-[#CDE4E6]/40">Click any step on the canvas to configure target, parameters, verification, or branching logic.</p>
      </div>
    );
  }

  const updateField = <K extends keyof WorkflowStep>(field: K, value: WorkflowStep[K]) => {
    onUpdateStep({
      ...step,
      [field]: value,
    });
  };

  const updateTargetField = (targetKey: string, val: any) => {
    onUpdateStep({
      ...step,
      target: {
        ...(step.target || {}),
        [targetKey]: val,
      },
    });
  };

  const isUrlValid = step.url ? isSafeUrl(step.url) : true;

  return (
    <div className="w-80 bg-[#1A2240] border-l border-[#F9DF9F]/20 flex flex-col h-full overflow-hidden text-xs text-[#CDE4E6] select-none">
      {/* Top Header */}
      <div className="p-3 border-b border-[#F9DF9F]/10 flex items-center justify-between bg-[#263056]">
        <div>
          <span className="text-[10px] uppercase font-bold text-[#F9DF9F]">Step Properties</span>
          <h4 className="font-bold text-sm text-[#CDE4E6] truncate">
            {step.description || `${step.type.toUpperCase()} Step`}
          </h4>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onMoveStep(step.id, 'up')}
            className="p-1 hover:bg-white/10 rounded text-[#CDE4E6]"
            title="Move Step Earlier in Sequence"
          >
            ↑
          </button>
          <button
            onClick={() => onMoveStep(step.id, 'down')}
            className="p-1 hover:bg-white/10 rounded text-[#CDE4E6]"
            title="Move Step Later in Sequence"
          >
            ↓
          </button>
          <button
            onClick={() => onDuplicateStep(step.id)}
            className="p-1 hover:bg-white/10 rounded text-[#CDE4E6]"
            title="Duplicate Step"
          >
            ⎘
          </button>
          <button
            onClick={() => onDeleteStep(step.id)}
            className="p-1 hover:bg-red-500/20 text-red-400 rounded"
            title="Delete Step"
          >
            🗑
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#F9DF9F]/10 text-[11px] bg-[#1e2642]">
        <button
          onClick={() => setActiveTab('action')}
          className={`flex-1 py-2 text-center font-semibold transition-colors ${
            activeTab === 'action'
              ? 'text-[#F9DF9F] border-b-2 border-[#F9DF9F] bg-white/5'
              : 'text-[#CDE4E6]/60 hover:text-[#CDE4E6]'
          }`}
        >
          Action
        </button>
        <button
          onClick={() => setActiveTab('target')}
          className={`flex-1 py-2 text-center font-semibold transition-colors ${
            activeTab === 'target'
              ? 'text-[#F9DF9F] border-b-2 border-[#F9DF9F] bg-white/5'
              : 'text-[#CDE4E6]/60 hover:text-[#CDE4E6]'
          }`}
        >
          Target
        </button>
        <button
          onClick={() => setActiveTab('verification')}
          className={`flex-1 py-2 text-center font-semibold transition-colors ${
            activeTab === 'verification'
              ? 'text-[#F9DF9F] border-b-2 border-[#F9DF9F] bg-white/5'
              : 'text-[#CDE4E6]/60 hover:text-[#CDE4E6]'
          }`}
        >
          Verify
        </button>
        {step.type === 'condition' && (
          <button
            onClick={() => setActiveTab('logic')}
            className={`flex-1 py-2 text-center font-semibold transition-colors ${
              activeTab === 'logic'
                ? 'text-[#F9DF9F] border-b-2 border-[#F9DF9F] bg-white/5'
                : 'text-[#CDE4E6]/60 hover:text-[#CDE4E6]'
            }`}
          >
            Branch
          </button>
        )}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* ACTION TAB */}
        {activeTab === 'action' && (
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Step Description
              </label>
              <input
                type="text"
                value={step.description || ''}
                onChange={(e) => updateField('description', e.target.value)}
                placeholder="e.g. Enter checkout billing email"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs focus:ring-1 focus:ring-[#F9DF9F] outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Action Type
              </label>
              <select
                value={step.type}
                onChange={(e) => updateField('type', e.target.value as ActionType)}
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs focus:ring-1 focus:ring-[#F9DF9F] outline-none capitalize"
              >
                {[
                  'click',
                  'input',
                  'navigate',
                  'select',
                  'checkbox',
                  'radio',
                  'scroll',
                  'wait',
                  'copy',
                  'paste',
                  'condition',
                  'extract',
                ].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Target Page URL
              </label>
              <input
                type="text"
                value={step.url || ''}
                onChange={(e) => updateField('url', e.target.value)}
                placeholder="https://example.com/page"
                className={`w-full px-2.5 py-1.5 bg-[#263056] rounded border text-xs focus:ring-1 outline-none font-mono text-[11px] ${
                  isUrlValid ? 'border-[#CDE4E6]/20 focus:ring-[#F9DF9F]' : 'border-red-500 focus:ring-red-500'
                }`}
              />
              {!isUrlValid && (
                <p className="text-[10px] text-red-400 mt-1">⚠️ URL scheme is unsupported or unsafe</p>
              )}
            </div>

            {/* Input Value & Masking */}
            {(step.type === 'input' || step.type === 'wait') && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase">
                    {step.type === 'wait' ? 'Wait Duration (ms)' : 'Input Value'}
                  </label>
                  {step.type === 'input' && (
                    <button
                      type="button"
                      onClick={() => setShowSensitive((p) => !p)}
                      className="text-[10px] text-[#CDE4E6]/70 hover:text-[#F9DF9F]"
                    >
                      {showSensitive ? 'Hide' : 'Reveal'}
                    </button>
                  )}
                </div>

                <input
                  type={step.sensitive && !showSensitive ? 'password' : 'text'}
                  value={step.value ?? ''}
                  onChange={(e) => updateField('value', e.target.value)}
                  placeholder={step.type === 'wait' ? '2000' : 'Text value or {{variable}}'}
                  className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs focus:ring-1 focus:ring-[#F9DF9F] outline-none"
                />

                {step.type === 'input' && (
                  <label className="flex items-center gap-2 mt-2 cursor-pointer text-[11px]">
                    <input
                      type="checkbox"
                      checked={Boolean(step.sensitive)}
                      onChange={(e) => updateField('sensitive', e.target.checked)}
                      className="rounded bg-[#263056] border-[#CDE4E6]/30 text-[#F9DF9F] focus:ring-0"
                    />
                    <span>Mark as sensitive secret (masked in logs & canvas)</span>
                  </label>
                )}
              </div>
            )}

            {/* Extract Config */}
            {step.type === 'extract' && (
              <div className="p-2.5 bg-[#263056]/60 rounded-md space-y-2 border border-[#CDE4E6]/10">
                <span className="text-[10px] font-bold text-[#38bdf8] uppercase">Output Extraction</span>
                <div>
                  <label className="block text-[10px] text-[#CDE4E6]/80 mb-0.5">Variable Destination</label>
                  <input
                    type="text"
                    value={step.extraction?.variableName || ''}
                    onChange={(e) =>
                      updateField('extraction', {
                        ...(step.extraction || { id: `ext_${Date.now()}`, type: 'inner_text' }),
                        variableName: e.target.value,
                      })
                    }
                    placeholder="myExtractedVar"
                    className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#CDE4E6]/80 mb-0.5">Extraction Mode</label>
                  <select
                    value={step.extraction?.type || 'inner_text'}
                    onChange={(e) =>
                      updateField('extraction', {
                        ...(step.extraction || { id: `ext_${Date.now()}`, variableName: 'extractedVal' }),
                        type: e.target.value as any,
                      })
                    }
                    className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                  >
                    <option value="inner_text">Inner Text Content</option>
                    <option value="text_content">Text Content</option>
                    <option value="attribute">Element Attribute</option>
                    <option value="input_value">Form Input Value</option>
                    <option value="checked_state">Checkbox Checked State</option>
                    <option value="href">Link URL (href)</option>
                  </select>
                </div>
                {step.extraction?.type === 'attribute' && (
                  <div>
                    <label className="block text-[10px] text-[#CDE4E6]/80 mb-0.5">Attribute Name</label>
                    <input
                      type="text"
                      value={step.extraction?.attributeName || ''}
                      onChange={(e) =>
                        updateField('extraction', {
                          ...step.extraction!,
                          attributeName: e.target.value,
                        })
                      }
                      placeholder="e.g. href, data-id, src"
                      className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TARGET TAB */}
        {activeTab === 'target' && (
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                CSS Selector
              </label>
              <input
                type="text"
                value={step.target?.selector || ''}
                onChange={(e) => updateTargetField('selector', e.target.value)}
                placeholder="button.submit, #main-input"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs font-mono text-[11px] focus:ring-1 focus:ring-[#F9DF9F] outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Accessible Name (ARIA Label)
              </label>
              <input
                type="text"
                value={step.target?.ariaLabel || ''}
                onChange={(e) => updateTargetField('ariaLabel', e.target.value)}
                placeholder="e.g. Submit Order"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs focus:ring-1 focus:ring-[#F9DF9F] outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Visible Text
              </label>
              <input
                type="text"
                value={step.target?.text || ''}
                onChange={(e) => updateTargetField('text', e.target.value)}
                placeholder="Visible button or link label"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs focus:ring-1 focus:ring-[#F9DF9F] outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Tag Name
              </label>
              <input
                type="text"
                value={step.target?.tag || ''}
                onChange={(e) => updateTargetField('tag', e.target.value)}
                placeholder="button, a, input, div"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs font-mono outline-none"
              />
            </div>
          </div>
        )}

        {/* VERIFICATION TAB */}
        {activeTab === 'verification' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-[#F9DF9F] uppercase">
                Action Verification
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-[11px]">
                <input
                  type="checkbox"
                  checked={Boolean(step.verification?.enabled)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      updateField('verification', {
                        enabled: true,
                        strategy: 'element_visible',
                        timeoutMs: 5000,
                        pauseOnFailure: false,
                      });
                    } else {
                      updateField('verification', undefined);
                    }
                  }}
                  className="rounded bg-[#263056] text-[#F9DF9F]"
                />
                <span>Enable</span>
              </label>
            </div>

            {step.verification ? (
              <div className="space-y-3 p-2.5 bg-[#263056]/50 rounded border border-[#CDE4E6]/10">
                <div>
                  <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Strategy</label>
                  <select
                    value={step.verification.strategy || 'element_visible'}
                    onChange={(e) =>
                      updateField('verification', {
                        ...step.verification!,
                        strategy: e.target.value as any,
                      })
                    }
                    className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                  >
                    <option value="element_visible">Element Visible</option>
                    <option value="element_absent">Element Removed</option>
                    <option value="text_match">Text Matches</option>
                    <option value="value_match">Input Value Matches</option>
                    <option value="url_match">URL Matches</option>
                    <option value="url_changed">URL Changed</option>
                    <option value="checked_state">Checked State</option>
                    <option value="auto">Auto-detect</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Expected Postcondition Value</label>
                  <input
                    type="text"
                    value={String(step.verification.postcondition?.expectedValue ?? '')}
                    onChange={(e) =>
                      updateField('verification', {
                        ...step.verification!,
                        postcondition: {
                          type: (step.verification?.postcondition?.type || 'element_visible') as any,
                          expectedValue: e.target.value,
                        },
                      })
                    }
                    placeholder="Expected text, value, or URL pattern"
                    className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Timeout (ms)</label>
                    <input
                      type="number"
                      value={step.verification.timeoutMs || 5000}
                      onChange={(e) =>
                        updateField('verification', {
                          ...step.verification!,
                          timeoutMs: parseInt(e.target.value, 10) || 5000,
                        })
                      }
                      className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">On Failure</label>
                    <select
                      value={step.verification.pauseOnFailure ? 'pause' : 'fail'}
                      onChange={(e) =>
                        updateField('verification', {
                          ...step.verification!,
                          pauseOnFailure: e.target.value === 'pause',
                        })
                      }
                      className="w-full px-2 py-1 bg-[#1A2240] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                    >
                      <option value="fail">Fail Replay</option>
                      <option value="pause">Pause for Recovery</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-[#CDE4E6]/50">
                Verification checks postconditions after action execution to guarantee the DOM or page state transitioned safely.
              </p>
            )}
          </div>
        )}

        {/* LOGIC / BRANCHING TAB */}
        {activeTab === 'logic' && step.type === 'condition' && (
          <div className="space-y-3">
            <span className="text-[10px] font-bold text-[#F9DF9F] uppercase">Condition & Branching</span>

            <div>
              <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Evaluation Source</label>
              <select
                value={step.condition?.source || 'variable'}
                onChange={(e) =>
                  updateField('condition', {
                    ...(step.condition || { operator: 'equals', onTrue: 'next', onFalse: 'end' }),
                    source: e.target.value as any,
                  })
                }
                className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              >
                <option value="variable">Runtime Variable</option>
                <option value="verification">Verification Result</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">
                {step.condition?.source === 'verification' ? 'Step ID to Check' : 'Variable Name'}
              </label>
              <input
                type="text"
                value={step.condition?.name || ''}
                onChange={(e) =>
                  updateField('condition', {
                    ...(step.condition || { source: 'variable', operator: 'equals', onTrue: 'next', onFalse: 'end' }),
                    name: e.target.value,
                  })
                }
                placeholder={step.condition?.source === 'verification' ? 'e.g. step_1' : 'e.g. userRole'}
                className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Operator</label>
                <select
                  value={step.condition?.operator || 'equals'}
                  onChange={(e) =>
                    updateField('condition', {
                      ...(step.condition || { source: 'variable', onTrue: 'next', onFalse: 'end' }),
                      operator: e.target.value as any,
                    })
                  }
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                >
                  <option value="equals">Equals (==)</option>
                  <option value="not_equals">Not Equals (!=)</option>
                  <option value="contains">Contains</option>
                  <option value="exists">Exists</option>
                  <option value="is_empty">Is Empty</option>
                  <option value="greater_than">Greater (&gt;)</option>
                  <option value="greater_than_or_equal">Greater or Equal (&gt;=)</option>
                  <option value="less_than">Less (&lt;)</option>
                  <option value="less_than_or_equal">Less or Equal (&lt;=)</option>
                  <option value="starts_with">Starts With</option>
                  <option value="ends_with">Ends With</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Expected Value</label>
                <input
                  type="text"
                  value={String(step.condition?.value ?? '')}
                  onChange={(e) =>
                    updateField('condition', {
                      ...(step.condition || { source: 'variable', operator: 'equals', onTrue: 'next', onFalse: 'end' }),
                      value: e.target.value,
                    })
                  }
                  placeholder="admin"
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-[#F9DF9F]/10 space-y-2">
              <div>
                <label className="block text-[10px] font-bold text-emerald-400 uppercase mb-1">
                  On True Branch Target
                </label>
                <select
                  value={step.condition?.onTrue || 'next'}
                  onChange={(e) =>
                    updateField('condition', {
                      ...(step.condition || { source: 'variable', operator: 'equals', onFalse: 'end' }),
                      onTrue: e.target.value,
                    })
                  }
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                >
                  <option value="next">Next Step in Order</option>
                  <option value="end">Complete Workflow (End)</option>
                  {allSteps
                    .filter((s) => s.id !== step.id)
                    .map((s, idx) => (
                      <option key={s.id} value={s.id}>
                        Step #{idx + 1}: {s.description || s.type}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-amber-400 uppercase mb-1">
                  On False Branch Target
                </label>
                <select
                  value={step.condition?.onFalse || 'end'}
                  onChange={(e) =>
                    updateField('condition', {
                      ...(step.condition || { source: 'variable', operator: 'equals', onTrue: 'next' }),
                      onFalse: e.target.value,
                    })
                  }
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                >
                  <option value="next">Next Step in Order</option>
                  <option value="end">Complete Workflow (End)</option>
                  {allSteps
                    .filter((s) => s.id !== step.id)
                    .map((s, idx) => (
                      <option key={s.id} value={s.id}>
                        Step #{idx + 1}: {s.description || s.type}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
