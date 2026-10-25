import React, { useState, useEffect } from 'react';
import type { WorkflowTemplate } from '../../workflow/templates/template-types';
import { TemplateRegistry } from '../../workflow/templates/TemplateRegistry';
import type { Workflow } from '../../shared/types/workflow';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';

interface TemplatesViewProps {
  onWorkflowCreated: (wf: Workflow) => void;
  userId?: string;
}

export const TemplatesView: React.FC<TemplatesViewProps> = ({ onWorkflowCreated, userId }) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [previewTemplate, setPreviewTemplate] = useState<WorkflowTemplate | null>(null);

  useEffect(() => {
    TemplateRegistry.getAllTemplates()
      .then((res) => {
        setTemplates(res);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load templates:', err);
        setLoading(false);
      });
  }, []);

  const handleUseTemplate = async (templateId: string) => {
    try {
      const newWorkflow = await TemplateRegistry.createWorkflowFromTemplate(templateId, {
        ownerId: userId || 'local_user',
      });
      await WorkflowStorage.createWorkflow(newWorkflow);
      onWorkflowCreated(newWorkflow);
    } catch (err: any) {
      alert(`Failed to create workflow from template: ${err.message}`);
    }
  };

  const filtered = templates.filter((t) =>
    selectedCategory === 'all' ? true : t.category === selectedCategory
  );

  return (
    <div className="w-full flex flex-col space-y-3 text-xs text-[#CDE4E6]">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-[#F9DF9F] flex items-center gap-1.5">
          <span>📚</span> Workflow Templates
        </h3>
        <span className="text-[10px] text-[#CDE4E6]/50">{templates.length} available</span>
      </div>

      {/* Category Filter */}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none text-[10px]">
        {['all', 'form', 'extraction', 'navigation'].map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-2.5 py-1 rounded-md capitalize font-semibold transition-colors ${
              selectedCategory === cat
                ? 'bg-[#F9DF9F] text-[#263056]'
                : 'bg-[#1A2240] text-[#CDE4E6]/70 hover:text-[#CDE4E6]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">Loading templates...</div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">No templates found</div>
      ) : (
        <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
          {filtered.map((tpl) => (
            <div
              key={tpl.id}
              className="p-3 rounded-lg bg-[#1A2240] border border-[#CDE4E6]/10 hover:border-[#F9DF9F]/40 transition-all flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-bold text-xs text-[#F9DF9F]">{tpl.name}</h4>
                  <p className="text-[10px] text-[#CDE4E6]/70 mt-0.5 line-clamp-2">{tpl.description}</p>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#263056] text-[#38bdf8] uppercase font-mono">
                  {tpl.steps.length} steps
                </span>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-1">
                {tpl.tags.map((tag) => (
                  <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-black/20 text-[#CDE4E6]/60">
                    #{tag}
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 pt-1 border-t border-[#CDE4E6]/10">
                <button
                  onClick={() => setPreviewTemplate(tpl)}
                  className="px-2.5 py-1 rounded bg-[#263056] hover:bg-white/10 text-[10px] font-semibold text-[#CDE4E6]"
                >
                  Inspect
                </button>
                <button
                  onClick={() => handleUseTemplate(tpl.id)}
                  className="px-3 py-1 rounded bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[10px] font-bold text-[#263056] shadow-sm"
                >
                  Use Template
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inspect Template Modal */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
          <div className="bg-[#1A2240] border border-[#F9DF9F]/30 rounded-xl p-4 max-w-sm w-full max-h-[80vh] flex flex-col text-xs text-[#CDE4E6] space-y-3">
            <div className="flex items-center justify-between border-b border-[#F9DF9F]/10 pb-2">
              <h4 className="font-bold text-sm text-[#F9DF9F]">{previewTemplate.name}</h4>
              <button onClick={() => setPreviewTemplate(null)} className="font-bold text-sm">✕</button>
            </div>
            <p className="text-[11px] text-[#CDE4E6]/80">{previewTemplate.description}</p>

            <div className="flex-1 overflow-y-auto space-y-1.5 py-1">
              <span className="font-bold text-[10px] text-[#F9DF9F] uppercase">Steps In Template</span>
              {previewTemplate.steps.map((s, idx) => (
                <div key={s.id} className="p-1.5 bg-[#263056] rounded text-[10px] flex items-center justify-between">
                  <span>#{idx + 1} {s.type.toUpperCase()}</span>
                  <span className="text-[#CDE4E6]/60 truncate max-w-[150px]">{s.description || s.url}</span>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#F9DF9F]/10">
              <button
                onClick={() => setPreviewTemplate(null)}
                className="px-3 py-1 rounded bg-[#263056] text-xs font-semibold"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const id = previewTemplate.id;
                  setPreviewTemplate(null);
                  handleUseTemplate(id);
                }}
                className="px-3 py-1 rounded bg-[#F9DF9F] text-[#263056] text-xs font-bold"
              >
                Instantiate Workflow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
