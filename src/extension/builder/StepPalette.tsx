import React, { useState, useEffect } from 'react';
import type { ActionType } from '../../shared/types/workflow';
import { ComponentRegistry } from '../../workflow/components/ComponentRegistry';
import type { WorkflowComponent } from '../../workflow/components/component-types';

interface ActionItem {
  type: ActionType;
  name: string;
  category: 'interaction' | 'navigation' | 'logic';
  description: string;
  icon: string;
  isComponent?: boolean;
  componentId?: string;
}

const ACTION_DEFINITIONS: ActionItem[] = [
  // Navigation & Delay
  {
    type: 'navigate',
    name: 'Navigate',
    category: 'navigation',
    description: 'Loads a target URL in the active tab',
    icon: '🌐',
  },
  {
    type: 'wait',
    name: 'Wait / Delay',
    category: 'navigation',
    description: 'Pauses execution for a specified duration or condition',
    icon: '⏱️',
  },
  // User Interactions
  {
    type: 'click',
    name: 'Click',
    category: 'interaction',
    description: 'Dispatches click or focus on the target element',
    icon: '👆',
  },
  {
    type: 'input',
    name: 'Type Text',
    category: 'interaction',
    description: 'Types text into input or textarea, with variable support',
    icon: '⌨️',
  },
  {
    type: 'select',
    name: 'Select Option',
    category: 'interaction',
    description: 'Selects a dropdown option by value or visible label',
    icon: '📑',
  },
  {
    type: 'checkbox',
    name: 'Toggle Checkbox',
    category: 'interaction',
    description: 'Sets checkbox state to checked or unchecked',
    icon: '☑️',
  },
  {
    type: 'radio',
    name: 'Select Radio',
    category: 'interaction',
    description: 'Selects a radio button control',
    icon: '🔘',
  },
  {
    type: 'scroll',
    name: 'Scroll',
    category: 'interaction',
    description: 'Scrolls element or window to specified coordinates',
    icon: '📜',
  },
  {
    type: 'copy',
    name: 'Copy to Clipboard',
    category: 'interaction',
    description: 'Copies text from element or variable into clipboard',
    icon: '📋',
  },
  {
    type: 'paste',
    name: 'Paste from Clipboard',
    category: 'interaction',
    description: 'Pastes text into target input field',
    icon: '📥',
  },
  // Logic & Extraction
  {
    type: 'condition',
    name: 'Branch Condition',
    category: 'logic',
    description: 'Evaluates variable or DOM condition with True/False branches',
    icon: '🔀',
  },
  {
    type: 'extract',
    name: 'Extract Output',
    category: 'logic',
    description: 'Extracts DOM text, attribute, or value into runtime variable',
    icon: '🔍',
  },
];

interface StepPaletteProps {
  onAddStep: (type: ActionType, componentId?: string) => void;
}

export const StepPalette: React.FC<StepPaletteProps> = ({ onAddStep }) => {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'interaction' | 'navigation' | 'logic' | 'components'>('all');
  const [components, setComponents] = useState<WorkflowComponent[]>([]);

  useEffect(() => {
    ComponentRegistry.getAllComponents().then((comps) => {
      setComponents(comps);
    });
  }, []);

  const componentActions: ActionItem[] = components.map((comp) => ({
    type: 'click' as ActionType,
    name: comp.name,
    category: 'logic',
    description: comp.description || `Reusable component (${comp.steps.length} steps)`,
    icon: '🧩',
    isComponent: true,
    componentId: comp.id,
  }));

  const allItems = [...ACTION_DEFINITIONS, ...componentActions];

  const filteredItems = allItems.filter((item) => {
    const matchesCategory =
      selectedCategory === 'all'
        ? true
        : selectedCategory === 'components'
        ? item.isComponent
        : !item.isComponent && item.category === selectedCategory;

    const matchesSearch =
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase());

    return matchesCategory && matchesSearch;
  });

  return (
    <div className="w-64 bg-[#1A2240] border-r border-[#F9DF9F]/20 flex flex-col h-full select-none">
      <div className="p-3 border-b border-[#F9DF9F]/10">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#F9DF9F] mb-2 flex items-center justify-between">
          <span>Action Palette</span>
          <span className="text-[10px] text-[#CDE4E6]/50 font-normal">{filteredItems.length} items</span>
        </h3>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actions..."
          className="w-full px-2.5 py-1.5 text-xs bg-[#263056] text-[#CDE4E6] placeholder-[#CDE4E6]/40 rounded border border-[#CDE4E6]/20 focus:outline-none focus:ring-1 focus:ring-[#F9DF9F]"
        />
      </div>

      {/* Category Pills */}
      <div className="flex px-2 py-2 gap-1 overflow-x-auto border-b border-[#F9DF9F]/10 text-[11px] scrollbar-none">
        {(['all', 'interaction', 'navigation', 'logic', 'components'] as const).map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-2 py-1 rounded text-[10px] capitalize font-medium transition-colors whitespace-nowrap ${
              selectedCategory === cat
                ? 'bg-[#F9DF9F] text-[#263056] font-bold shadow-sm'
                : 'text-[#CDE4E6]/70 hover:text-[#CDE4E6] hover:bg-white/5'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Action Items List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {filteredItems.length === 0 ? (
          <div className="text-center py-8 text-xs text-[#CDE4E6]/50">No matching actions</div>
        ) : (
          filteredItems.map((item, idx) => (
            <button
              type="button"
              key={`${item.type}_${item.componentId || idx}`}
              onClick={() => onAddStep(item.type, item.componentId)}
              className="w-full text-left group p-2 rounded-md bg-[#263056]/80 hover:bg-[#263056] border border-[#CDE4E6]/10 hover:border-[#F9DF9F]/40 cursor-pointer transition-all shadow-sm flex items-start gap-2.5 active:scale-[0.98]"
              title={item.description}
            >
              <span className="text-base leading-none p-1 bg-black/20 rounded group-hover:scale-110 transition-transform">
                {item.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#CDE4E6] group-hover:text-[#F9DF9F] truncate">
                    {item.name}
                  </span>
                  {item.isComponent && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-purple-900/60 text-purple-300 font-mono">
                      COMP
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[#CDE4E6]/60 line-clamp-1 mt-0.5">{item.description}</p>
              </div>
            </button>
          ))
        )}
      </div>

      <div className="p-2 border-t border-[#F9DF9F]/10 text-[10px] text-center text-[#CDE4E6]/40">
        Click to add to canvas
      </div>
    </div>
  );
};
