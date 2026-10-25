import React, { useState, useRef, useMemo } from 'react';
import type { WorkflowStep } from '../../shared/types/workflow';
import type { Point, DragState, ConnectionDraft } from './builder-types';

interface WorkflowCanvasProps {
  steps: WorkflowStep[];
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepLayout: (stepId: string, x: number, y: number) => void;
  onConnectSteps: (fromStepId: string, toStepId: string, branch: 'next' | 'true' | 'false') => void;
  onDeleteStep: (stepId: string) => void;
  validationErrors?: Record<string, string[]>;
  unreachableStepIds?: string[];
}

const NODE_WIDTH = 230;
const NODE_HEIGHT = 110;

export const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({
  steps,
  selectedStepId,
  onSelectStep,
  onUpdateStepLayout,
  onConnectSteps,
  onDeleteStep,
  validationErrors = {},
  unreachableStepIds = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 50, y: 50 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Point>({ x: 0, y: 0 });

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);

  // Position lookup map
  const stepPositions = useMemo(() => {
    const map = new Map<string, Point>();
    steps.forEach((step, index) => {
      const x = step.layout?.x ?? (100 + (index % 4) * 280);
      const y = step.layout?.y ?? (100 + Math.floor(index / 4) * 180);
      map.set(step.id, { x, y });
    });
    return map;
  }, [steps]);

  // Handle canvas background pan
  const handleMouseDownBackground = (e: React.MouseEvent) => {
    if (e.target === containerRef.current || (e.target as HTMLElement).tagName === 'svg') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      onSelectStep(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    if (dragState) {
      const dx = (e.clientX - dragState.startMouse.x) / zoom;
      const dy = (e.clientY - dragState.startMouse.y) / zoom;
      const newX = Math.max(20, Math.round(dragState.startNode.x + dx));
      const newY = Math.max(20, Math.round(dragState.startNode.y + dy));
      onUpdateStepLayout(dragState.stepId, newX, newY);
      return;
    }

    if (connectionDraft && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left - pan.x) / zoom;
      const mouseY = (e.clientY - rect.top - pan.y) / zoom;
      setConnectionDraft((prev) => (prev ? { ...prev, currentMouse: { x: mouseX, y: mouseY } } : null));
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    setDragState(null);
    setConnectionDraft(null);
  };

  // Zoom controls
  const handleZoom = (delta: number) => {
    setZoom((prev) => Math.min(2.0, Math.max(0.4, Number((prev + delta).toFixed(2)))));
  };

  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 50, y: 50 });
  };

  const handleFitView = () => {
    if (steps.length === 0) return handleResetView();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    stepPositions.forEach((pos) => {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + NODE_HEIGHT);
    });

    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      const width = maxX - minX + 100;
      const height = maxY - minY + 100;
      const scaleX = clientWidth / width;
      const scaleY = clientHeight / height;
      const newZoom = Math.min(1.2, Math.max(0.5, Math.min(scaleX, scaleY)));
      setZoom(Number(newZoom.toFixed(2)));
      setPan({
        x: (clientWidth - width * newZoom) / 2 - minX * newZoom + 50,
        y: (clientHeight - height * newZoom) / 2 - minY * newZoom + 50,
      });
    }
  };

  // SVG Bézier Curve Path Helper
  const renderCurve = (
    from: Point,
    to: Point,
    color: string,
    label?: string,
    isDashed = false
  ) => {
    const startX = from.x + NODE_WIDTH / 2;
    const startY = from.y + NODE_HEIGHT;
    const endX = to.x + NODE_WIDTH / 2;
    const endY = to.y;

    const deltaY = Math.max(30, Math.abs(endY - startY) * 0.5);
    const path = `M ${startX} ${startY} C ${startX} ${startY + deltaY}, ${endX} ${endY - deltaY}, ${endX} ${endY}`;
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;

    return (
      <g key={`${from.x}_${from.y}_to_${to.x}_${to.y}_${label || ''}`}>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray={isDashed ? '5,5' : undefined}
          markerEnd="url(#arrowhead)"
          className="transition-all opacity-80 hover:opacity-100"
        />
        {label && (
          <g transform={`translate(${midX}, ${midY})`}>
            <rect
              x="-24"
              y="-10"
              width="48"
              height="20"
              rx="10"
              fill="#1A2240"
              stroke={color}
              strokeWidth="1.5"
            />
            <text
              textAnchor="middle"
              y="4"
              fill={color}
              fontSize="9"
              fontWeight="bold"
              fontFamily="sans-serif"
            >
              {label}
            </text>
          </g>
        )}
      </g>
    );
  };

  // Render Connections
  const renderedConnections = useMemo(() => {
    const list: React.ReactNode[] = [];

    steps.forEach((step, index) => {
      const fromPos = stepPositions.get(step.id);
      if (!fromPos) return;

      if (step.condition) {
        // True branch
        if (step.condition.onTrue && step.condition.onTrue !== 'end') {
          const targetId = step.condition.onTrue === 'next'
            ? steps[index + 1]?.id
            : step.condition.onTrue;
          const toPos = targetId ? stepPositions.get(targetId) : null;
          if (toPos) {
            list.push(renderCurve(fromPos, toPos, '#34d399', 'TRUE'));
          }
        }
        // False branch
        if (step.condition.onFalse && step.condition.onFalse !== 'end') {
          const targetId = step.condition.onFalse === 'next'
            ? steps[index + 1]?.id
            : step.condition.onFalse;
          const toPos = targetId ? stepPositions.get(targetId) : null;
          if (toPos) {
            list.push(renderCurve(fromPos, toPos, '#fbbf24', 'FALSE'));
          }
        }
      } else {
        // Normal sequential connection
        const nextStep = steps[index + 1];
        if (nextStep) {
          const toPos = stepPositions.get(nextStep.id);
          if (toPos) {
            list.push(renderCurve(fromPos, toPos, '#38bdf8'));
          }
        }
      }
    });

    return list;
  }, [steps, stepPositions]);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDownBackground}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className="relative flex-1 h-full bg-[#1e2642] overflow-hidden select-none cursor-grab active:cursor-grabbing"
      style={{
        backgroundImage: `radial-gradient(circle, rgba(205, 228, 230, 0.08) 1px, transparent 1px)`,
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      {/* Canvas Viewport Toolbar */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-1.5 bg-[#1A2240]/90 backdrop-blur border border-[#F9DF9F]/20 p-1.5 rounded-lg shadow-lg">
        <button
          onClick={() => handleZoom(0.1)}
          className="w-7 h-7 flex items-center justify-center text-xs font-bold text-[#CDE4E6] hover:bg-white/10 rounded"
          title="Zoom In"
        >
          +
        </button>
        <span className="text-[11px] font-mono text-[#F9DF9F] px-1 w-10 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => handleZoom(-0.1)}
          className="w-7 h-7 flex items-center justify-center text-xs font-bold text-[#CDE4E6] hover:bg-white/10 rounded"
          title="Zoom Out"
        >
          -
        </button>
        <div className="w-[1px] h-4 bg-[#CDE4E6]/20 mx-0.5" />
        <button
          onClick={handleFitView}
          className="px-2 h-7 text-[10px] font-semibold text-[#CDE4E6] hover:bg-white/10 rounded"
          title="Fit view to all steps"
        >
          Fit
        </button>
        <button
          onClick={handleResetView}
          className="px-2 h-7 text-[10px] font-semibold text-[#CDE4E6] hover:bg-white/10 rounded"
          title="Reset to 100%"
        >
          Reset
        </button>
      </div>

      {/* SVG Connections Layer */}
      <svg
        className="absolute top-0 left-0 w-full h-full pointer-events-none z-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="7"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
          </marker>
        </defs>

        {renderedConnections}

        {/* Draft Connection line */}
        {connectionDraft && stepPositions.get(connectionDraft.fromStepId) && (
          <path
            d={`M ${stepPositions.get(connectionDraft.fromStepId)!.x + NODE_WIDTH / 2} ${
              stepPositions.get(connectionDraft.fromStepId)!.y + NODE_HEIGHT
            } L ${connectionDraft.currentMouse.x} ${connectionDraft.currentMouse.y}`}
            fill="none"
            stroke="#F9DF9F"
            strokeWidth={2}
            strokeDasharray="4,4"
          />
        )}
      </svg>

      {/* Interactive HTML Nodes Container */}
      <div
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {steps.map((step, index) => {
          const pos = stepPositions.get(step.id) || { x: 100, y: 100 };
          const isSelected = selectedStepId === step.id;
          const errors = validationErrors[step.id] || [];
          const isUnreachable = unreachableStepIds.includes(step.id);

          return (
            <div
              key={step.id}
              data-testid={`canvas-node-${step.id}`}
              data-node-type={step.type}
              onClick={(e) => {
                e.stopPropagation();
                if (connectionDraft && connectionDraft.fromStepId !== step.id) {
                  onConnectSteps(connectionDraft.fromStepId, step.id, connectionDraft.type);
                  setConnectionDraft(null);
                } else {
                  onSelectStep(step.id);
                }
              }}
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                width: `${NODE_WIDTH}px`,
              }}
              className={`absolute pointer-events-auto rounded-lg shadow-lg border transition-shadow cursor-pointer select-none bg-[#1A2240] ${
                isSelected
                  ? 'border-[#F9DF9F] ring-2 ring-[#F9DF9F]/40 shadow-[#F9DF9F]/10'
                  : errors.length > 0
                  ? 'border-red-500 ring-1 ring-red-500/30'
                  : isUnreachable
                  ? 'border-amber-500/80'
                  : 'border-[#CDE4E6]/20 hover:border-[#CDE4E6]/50'
              }`}
            >
              {/* Input Port (Top) */}
              <div
                className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-[#263056] border-2 border-[#CDE4E6] hover:bg-[#F9DF9F] transition-colors"
                title="Input target port"
              />

              {/* Node Header (Draggable) */}
              <div
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelectStep(step.id);
                  setDragState({
                    stepId: step.id,
                    startMouse: { x: e.clientX, y: e.clientY },
                    startNode: { ...pos },
                  });
                }}
                className="p-2.5 bg-[#263056] rounded-t-lg border-b border-[#CDE4E6]/10 flex items-center justify-between cursor-move"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/30 text-[#F9DF9F] font-bold">
                    #{index + 1}
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-[#CDE4E6] truncate">
                    {step.type}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  {step.verification && (
                    <span className="text-[9px] px-1 py-0.5 bg-emerald-950 text-emerald-400 rounded font-semibold" title="Verification enabled">
                      VERIFIED
                    </span>
                  )}
                  {step.extraction && (
                    <span className="text-[9px] px-1 py-0.5 bg-sky-950 text-sky-400 rounded font-semibold" title="Output extraction">
                      EXTRACT
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteStep(step.id);
                    }}
                    className="w-5 h-5 flex items-center justify-center rounded text-red-400 hover:bg-red-500/20 text-xs"
                    title="Delete Step"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Node Body Details */}
              <div className="p-2.5 space-y-1.5 text-[11px]">
                {step.description && (
                  <p className="font-semibold text-[#F9DF9F] truncate" title={step.description}>
                    {step.description}
                  </p>
                )}

                {step.url && (
                  <p className="text-[#CDE4E6]/70 truncate font-mono text-[10px]" title={step.url}>
                    {step.url}
                  </p>
                )}

                {step.target?.ariaLabel || step.target?.text || step.target?.selector ? (
                  <div className="bg-[#263056]/60 p-1 rounded text-[10px] text-[#CDE4E6] truncate">
                    🎯 {step.target.ariaLabel || step.target.text || step.target.selector}
                  </div>
                ) : null}

                {step.value !== undefined && step.value !== null && (
                  <div className="text-[10px] text-[#CDE4E6]/80 truncate">
                    Value: <span className="font-mono text-[#F9DF9F]">{step.sensitive ? '••••••••' : String(step.value)}</span>
                  </div>
                )}

                {step.condition && (
                  <div className="p-1 rounded bg-amber-950/40 border border-amber-500/20 text-[10px] text-amber-300 truncate">
                    🔀 if {step.condition.name || 'element'} {step.condition.operator} {step.condition.value ?? ''}
                  </div>
                )}

                {/* Validation Warnings / Errors */}
                {errors.length > 0 && (
                  <p className="text-[10px] text-red-400 font-medium truncate" title={errors.join('; ')}>
                    ⚠️ {errors[0]}
                  </p>
                )}
                {isUnreachable && (
                  <p className="text-[10px] text-amber-400 font-medium truncate">
                    ⚠️ Unreachable step
                  </p>
                )}
              </div>

              {/* Output Connectors (Bottom) */}
              {step.type === 'condition' ? (
                <div className="flex justify-around py-1 bg-[#263056]/40 rounded-b-lg border-t border-[#CDE4E6]/10 text-[9px] font-bold">
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setConnectionDraft({
                        fromStepId: step.id,
                        type: 'true',
                        currentMouse: { x: pos.x + NODE_WIDTH / 4, y: pos.y + NODE_HEIGHT + 20 },
                      });
                    }}
                    className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded hover:bg-emerald-500/20 cursor-crosshair"
                    title="Connect TRUE branch"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    TRUE
                  </div>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setConnectionDraft({
                        fromStepId: step.id,
                        type: 'false',
                        currentMouse: { x: pos.x + (NODE_WIDTH * 3) / 4, y: pos.y + NODE_HEIGHT + 20 },
                      });
                    }}
                    className="flex items-center gap-1 text-amber-400 hover:text-amber-300 px-2 py-0.5 rounded hover:bg-amber-500/20 cursor-crosshair"
                    title="Connect FALSE branch"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    FALSE
                  </div>
                </div>
              ) : (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setConnectionDraft({
                      fromStepId: step.id,
                      type: 'next',
                      currentMouse: { x: pos.x + NODE_WIDTH / 2, y: pos.y + NODE_HEIGHT + 20 },
                    });
                  }}
                  className="flex items-center justify-center py-1 bg-[#263056]/30 hover:bg-[#38bdf8]/20 text-[#38bdf8] text-[9px] font-bold rounded-b-lg cursor-crosshair border-t border-[#CDE4E6]/10 transition-colors"
                  title="Connect to next step"
                >
                  <span className="w-2 h-2 rounded-full bg-[#38bdf8] mr-1" />
                  NEXT
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
