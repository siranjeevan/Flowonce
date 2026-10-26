import { useState, useEffect, useCallback } from 'react';
import type { Workflow } from '../../shared/types/workflow';
import { FirestoreStorageManager } from '../../workflow/storage/firestore-storage';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { LEGACY_STORAGE_KEYS } from '../../workflow/storage/storage-keys';
import { DatasetParser } from '../../replay/dataset/DatasetParser';
import { classifyActionSafety } from '../../replay/ActionVerifier';
import type { User } from 'firebase/auth';

export function WorkflowsList({ user, onOpenBuilder }: { user: User | null; onOpenBuilder?: (wf: Workflow) => void }) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [importId, setImportId] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [playingWorkflowId, setPlayingWorkflowId] = useState<string | null>(null);
  const [runningProgress, setRunningProgress] = useState<{ index: number, total: number, type: string } | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    id: string;
    index: number;
    message: string;
    isRecoveryRequired?: boolean;
    isUncertain?: boolean;
    datasetState?: any;
    session?: any;
  } | null>(null);
  const [confirmUnsafeRetry, setConfirmUnsafeRetry] = useState<Record<string, boolean>>({});
  const [pageInspection, setPageInspection] = useState<any>(null);
  const [recheckStatus, setRecheckStatus] = useState<any>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(1);

  // Phase 7: Variable & Dataset Run Modal State
  const [modalWorkflow, setModalWorkflow] = useState<Workflow | null>(null);
  const [modalVariables, setModalVariables] = useState<Record<string, any>>({});
  const [datasetFormat, setDatasetFormat] = useState<'csv' | 'json'>('csv');
  const [datasetContent, setDatasetContent] = useState<string>('');
  const [datasetParsed, setDatasetParsed] = useState<{ rowCount: number; columns: string[] } | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);

  useEffect(() => {
    // Initial status query on popup open
    chrome.runtime.sendMessage({ type: 'GET_REPLAY_STATUS' }, (resp) => {
      if (resp && resp.success && resp.session) {
        const session = resp.session;
        const progressType = session.datasetState
          ? `Rec ${session.datasetState.currentRecordIndex + 1}/${session.datasetState.totalRecords} • ${session.status.toLowerCase()}`
          : session.status.toLowerCase();

        if (
          session.status === 'RUNNING' ||
          session.status === 'WAITING' ||
          session.status === 'PAUSED' ||
          session.status === 'NAVIGATING'
        ) {
          setPlayingWorkflowId(session.workflowId);
          setRunningProgress({
            index: session.currentStepIndex + 1,
            total: session.totalSteps,
            type: progressType,
          });
        } else if (session.status === 'RECOVERY_REQUIRED') {
          setErrorState({
            id: session.workflowId,
            index: session.currentStepIndex + 1,
            message: session.lastError || 'Session requires recovery attention',
            isRecoveryRequired: true,
            isUncertain: session.actionState === 'OUTCOME_UNKNOWN',
            datasetState: session.datasetState,
            session,
          });
        } else if (session.status === 'FAILED') {
          setErrorState({
            id: session.workflowId,
            index: session.currentStepIndex + 1,
            message: session.lastError || 'Session failed',
            datasetState: session.datasetState,
            session,
          });
        }
      }
    });

    const listener = (message: any) => {
      if (message.type === 'REPLAY_FINISHED') {
        setPlayingWorkflowId(null);
        setRunningProgress(null);
      } else if (message.type === 'REPLAY_FAILED') {
        setPlayingWorkflowId(null);
        setRunningProgress(null);
        if (message.workflowId) {
          setErrorState({
            id: message.workflowId,
            index: message.index + 1,
            message: message.error
          });
        }
      } else if (message.type === 'REPLAY_STATUS_CHANGED' && message.payload?.session) {
        const session = message.payload.session;
        const progressType = session.datasetState
          ? `Rec ${session.datasetState.currentRecordIndex + 1}/${session.datasetState.totalRecords} • ${session.status.toLowerCase()}`
          : session.status.toLowerCase();

        if (
          session.status === 'RUNNING' ||
          session.status === 'WAITING' ||
          session.status === 'PAUSED' ||
          session.status === 'NAVIGATING'
        ) {
          setPlayingWorkflowId(session.workflowId);
          setRunningProgress({
            index: session.currentStepIndex + 1,
            total: session.totalSteps,
            type: progressType,
          });
        } else if (session.status === 'COMPLETED' || session.status === 'CANCELLED') {
          setPlayingWorkflowId(null);
          setRunningProgress(null);
          setErrorState(null);
        } else if (session.status === 'RECOVERY_REQUIRED') {
          setPlayingWorkflowId(null);
          setRunningProgress(null);
          setErrorState({
            id: session.workflowId,
            index: session.currentStepIndex + 1,
            message: session.lastError || 'Action outcome is uncertain. Replay paused.',
            isRecoveryRequired: true,
            isUncertain: session.actionState === 'OUTCOME_UNKNOWN',
            datasetState: session.datasetState,
            session,
          });
        } else if (session.status === 'FAILED') {
          setPlayingWorkflowId(null);
          setRunningProgress(null);
          setErrorState({
            id: session.workflowId,
            index: session.currentStepIndex + 1,
            message: session.lastError || 'Execution failed',
            datasetState: session.datasetState,
          });
        }
      } else if (message.type === 'REPLAY_STEP_START') {
        setRunningProgress({
          index: message.index + 1,
          total: message.total,
          type: message.stepType
        });
        if (message.workflowId) {
          setErrorState(prev => prev?.id === message.workflowId ? null : prev);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const fetchMergedWorkflows = useCallback(async () => {
    let cloudWfs: Workflow[] = [];
    if (user?.uid) {
      try {
        cloudWfs = await FirestoreStorageManager.getUserWorkflows(user.uid);
      } catch (cloudErr) {
        console.warn('[WorkflowsList] Cloud fetch failed, falling back to local workflows:', cloudErr);
      }
    }

    let localWfs: Workflow[] = [];
    try {
      localWfs = await WorkflowStorage.getAllWorkflows();
    } catch (localErr) {
      console.warn('[WorkflowsList] Local fetch error:', localErr);
    }

    const mergedMap = new Map<string, Workflow>();
    for (const lw of localWfs) {
      mergedMap.set(lw.id, lw);
    }
    for (const cw of cloudWfs) {
      const existing = mergedMap.get(cw.id);
      if (!existing || new Date(cw.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
        mergedMap.set(cw.id, cw);
      }
    }
    return Array.from(mergedMap.values());
  }, [user]);

  useEffect(() => {
    const loadWorkflows = async () => {
      setLoading(true);
      try {
        const wfs = await fetchMergedWorkflows();
        setWorkflows(wfs);
      } catch (e) {
        console.error('Failed to load workflows', e);
      } finally {
        setLoading(false);
      }
    };
    loadWorkflows();
  }, [fetchMergedWorkflows]);

  const reloadWorkflows = async () => {
    setLoading(true);
    try {
      const wfs = await fetchMergedWorkflows();
      setWorkflows(wfs);
      setSelectedIds(new Set()); // Clear selection on reload
    } catch (e) {
      console.error('Failed to load workflows', e);
    } finally {
      setLoading(false);
    }
  };

  const playWorkflow = async (workflow: Workflow) => {
    setErrorState(null);
    setPlayingWorkflowId(workflow.id);
    setRunningProgress({ index: 1, total: workflow.steps.length, type: 'starting' });

    let targetTabId: number | undefined;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    } catch {}

    chrome.runtime.sendMessage(
      { 
        type: 'PLAY_WORKFLOW', 
        payload: { workflow, variables: {}, speedMultiplier: speed, tabId: targetTabId } 
      },
      (response) => {
        if (response && !response.success && response.error) {
          setErrorState({
            id: workflow.id,
            index: 0,
            message: response.error,
          });
          setPlayingWorkflowId(null);
          setRunningProgress(null);
        } else {
          setTimeout(() => window.close(), 100);
        }
      }
    );
  };

  const openDataModal = (workflow: Workflow) => {
    setModalWorkflow(workflow);
    const initialVars: Record<string, any> = {};
    if (workflow.variables) {
      for (const v of workflow.variables) {
        if (v.defaultValue !== undefined) {
          initialVars[v.name] = v.defaultValue;
        }
      }
    }
    setModalVariables(initialVars);
    if (workflow.dataset?.rawContent) {
      const format = workflow.dataset.sourceType === 'inline_json' ? 'json' : 'csv';
      setDatasetFormat(format);
      handleDatasetContentChange(workflow.dataset.rawContent, format);
    } else {
      setDatasetContent('');
      setDatasetParsed(null);
      setDatasetError(null);
    }
  };

  const closeModal = () => {
    setModalWorkflow(null);
    setModalVariables({});
    setDatasetContent('');
    setDatasetParsed(null);
    setDatasetError(null);
  };

  const handleDatasetFormatChange = (format: 'csv' | 'json') => {
    setDatasetFormat(format);
    if (datasetContent.trim()) {
      handleDatasetContentChange(datasetContent, format);
    }
  };

  const handleDatasetContentChange = (content: string, format = datasetFormat) => {
    setDatasetContent(content);
    if (!content.trim()) {
      setDatasetParsed(null);
      setDatasetError(null);
      return;
    }
    try {
      if (format === 'csv') {
        const parsed = DatasetParser.parseCSV(content);
        setDatasetParsed({ rowCount: parsed.rowCount, columns: parsed.columns });
        setDatasetError(null);
      } else {
        const parsed = DatasetParser.parseJSON(content);
        setDatasetParsed({ rowCount: parsed.rowCount, columns: parsed.columns });
        setDatasetError(null);
      }
    } catch (err: any) {
      setDatasetParsed(null);
      setDatasetError(err?.message || 'Invalid dataset format');
    }
  };

  const handleDatasetFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = (event.target?.result as string) || '';
      const format = file.name.endsWith('.json') ? 'json' : 'csv';
      setDatasetFormat(format);
      handleDatasetContentChange(content, format);
    };
    reader.readAsText(file);
  };

  const clearDataset = () => {
    setDatasetContent('');
    setDatasetParsed(null);
    setDatasetError(null);
  };

  const startSingleExecutionWithVariables = async () => {
    if (!modalWorkflow) return;
    const wf = modalWorkflow;
    closeModal();
    setErrorState(null);
    setPlayingWorkflowId(wf.id);
    setRunningProgress({ index: 1, total: wf.steps.length, type: 'starting' });

    let targetTabId: number | undefined;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    } catch {}

    chrome.runtime.sendMessage(
      { 
        type: 'PLAY_WORKFLOW', 
        payload: { workflow: wf, variables: modalVariables, speedMultiplier: speed, tabId: targetTabId } 
      },
      (response) => {
        if (response && !response.success && response.error) {
          setErrorState({
            id: wf.id,
            index: 0,
            message: response.error,
          });
          setPlayingWorkflowId(null);
          setRunningProgress(null);
        } else {
          setTimeout(() => window.close(), 100);
        }
      }
    );
  };

  const startDatasetExecution = async () => {
    if (!modalWorkflow || !datasetParsed) return;
    const wf = modalWorkflow;
    closeModal();
    setErrorState(null);
    setPlayingWorkflowId(wf.id);
    setRunningProgress({ index: 1, total: wf.steps.length, type: `Rec 1/${datasetParsed.rowCount} • starting` });

    let targetTabId: number | undefined;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    } catch {}

    chrome.runtime.sendMessage(
      {
        type: 'PLAY_DATASET',
        payload: {
          workflow: wf,
          dataset: {
            sourceType: datasetFormat === 'csv' ? 'inline_csv' : 'inline_json',
            rawContent: datasetContent,
            totalRecords: datasetParsed.rowCount,
            columns: datasetParsed.columns,
          },
          variables: modalVariables,
          speedMultiplier: speed,
          tabId: targetTabId,
        }
      },
      (response) => {
        if (response && !response.success && response.error) {
          setErrorState({
            id: wf.id,
            index: 0,
            message: response.error,
          });
          setPlayingWorkflowId(null);
          setRunningProgress(null);
        } else {
          setTimeout(() => window.close(), 100);
        }
      }
    );
  };

  const shareWorkflow = (workflowId: string) => {
    navigator.clipboard.writeText(workflowId);
    alert(`Workflow ID copied to clipboard: ${workflowId}\n\nShare this ID with anyone to let them import it!`);
  };

  const removeWorkflowFromAllStorages = async (workflowId: string) => {
    // 1. Delete from canonical local storage
    try {
      await WorkflowStorage.deleteWorkflow(workflowId);
    } catch (err) {
      console.warn('[WorkflowsList] Failed to delete from canonical local storage:', err);
    }

    // 2. Filter out from legacy storage keys if present
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const legacyData = await chrome.storage.local.get([
          LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS,
          LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS,
        ]);
        const updates: Record<string, unknown> = {};

        if (Array.isArray(legacyData[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS])) {
          updates[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] = (
            legacyData[LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS] as any[]
          ).filter((w) => w && w.id !== workflowId);
        }

        if (Array.isArray(legacyData[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS])) {
          updates[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] = (
            legacyData[LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS] as any[]
          ).filter((w) => w && w.id !== workflowId);
        }

        if (Object.keys(updates).length > 0) {
          await chrome.storage.local.set(updates);
        }
      }
    } catch (err) {
      console.warn('[WorkflowsList] Failed to delete from legacy storage:', err);
    }

    // 3. Delete from Firestore cloud if user is authenticated
    if (user?.uid) {
      try {
        await FirestoreStorageManager.deleteWorkflow(workflowId);
      } catch (err) {
        console.warn('[WorkflowsList] Failed to delete from Firestore cloud:', err);
      }
    }
  };

  const deleteWorkflow = async (workflowId: string) => {
    if (confirm('Are you sure you want to delete this workflow?')) {
      // Optimistically remove from state so UI updates instantly
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(workflowId);
        return next;
      });

      setLoading(true);
      try {
        await removeWorkflowFromAllStorages(workflowId);
        await reloadWorkflows();
      } catch (e) {
        console.error('Failed to delete workflow', e);
        alert('Failed to delete workflow.');
      } finally {
        setLoading(false);
      }
    }
  };

  const deleteSelectedWorkflows = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (confirm(`Are you sure you want to delete ${count} selected workflow(s)?`)) {
      const idsToDelete = Array.from(selectedIds);
      // Optimistically remove all selected from UI state
      setWorkflows((prev) => prev.filter((w) => !selectedIds.has(w.id)));
      setSelectedIds(new Set());

      setLoading(true);
      try {
        await Promise.all(idsToDelete.map((id) => removeWorkflowFromAllStorages(id)));
        await reloadWorkflows();
      } catch (e) {
        console.error('Failed to delete selected workflows', e);
        alert('Failed to delete some or all workflows.');
      } finally {
        setLoading(false);
      }
    }
  };

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === workflows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(workflows.map(w => w.id)));
    }
  };

  const handleImport = async () => {
    if (!importId.trim()) return;
    try {
      setLoading(true);
      const wf = await FirestoreStorageManager.getWorkflow(importId.trim());
      if (wf) {
        // Create a copy for the current user
        const importedWf: Workflow = {
          ...wf,
          id: `WF_${Date.now().toString(36).toUpperCase()}`,
          ownerId: user?.uid || 'local_user',
          name: `${wf.name} (Imported)`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await FirestoreStorageManager.saveWorkflow(importedWf);
        alert('Workflow imported successfully!');
        setImportId('');
        setShowImport(false);
        reloadWorkflows();
      } else {
        alert('Workflow not found. It may be private or invalid.');
      }
    } catch (e) {
      console.error('Import failed', e);
      alert('Failed to import workflow.');
    } finally {
      setLoading(false);
    }
  };

  const filteredWorkflows = workflows.filter((wf) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      wf.name.toLowerCase().includes(q) ||
      wf.steps.some(
        (s) =>
          (s.url && s.url.toLowerCase().includes(q)) ||
          (s.target?.text && s.target.text.toLowerCase().includes(q))
      )
    );
  });

  if (loading) return (
    <div className="w-full flex flex-col space-y-2 pb-2 animate-in fade-in duration-200">
      {/* Skeleton Action Bar */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-[30px] rounded-lg bg-[#0D1224] border border-white/5 skeleton-shimmer"></div>
        <div className="w-16 h-[30px] rounded-lg bg-[#0D1224] border border-white/5 skeleton-shimmer"></div>
        <div className="w-12 h-[30px] rounded-lg bg-[#0D1224] border border-white/5 skeleton-shimmer"></div>
      </div>

      {/* Skeleton Subheader */}
      <div className="flex justify-between items-center py-1 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-24 h-3.5 rounded bg-white/10 skeleton-shimmer"></div>
          <div className="w-6 h-3.5 rounded-full bg-white/5 skeleton-shimmer"></div>
        </div>
        <div className="w-14 h-3.5 rounded bg-white/5 skeleton-shimmer"></div>
      </div>

      {/* Skeleton Cards List */}
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl p-2.5 bg-[#141A33]/70 border border-white/5 flex flex-col space-y-2 shadow-sm"
          >
            {/* Top row */}
            <div className="flex items-start gap-2">
              <div className="w-3.5 h-3.5 rounded bg-white/10 skeleton-shimmer mt-0.5 shrink-0"></div>
              <div className="flex-1 space-y-1.5 min-w-0">
                <div className={`h-3 rounded bg-white/10 skeleton-shimmer ${i === 1 ? 'w-3/4' : i === 2 ? 'w-2/3' : 'w-4/5'}`}></div>
                <div className="flex items-center gap-1.5">
                  <div className="w-12 h-2.5 rounded bg-[#F9DF9F]/10 skeleton-shimmer"></div>
                  <div className="w-16 h-2.5 rounded bg-cyan-400/10 skeleton-shimmer"></div>
                  <div className="w-10 h-2.5 rounded bg-white/5 skeleton-shimmer"></div>
                </div>
              </div>
              <div className="w-4 h-4 rounded bg-white/5 skeleton-shimmer shrink-0"></div>
            </div>

            {/* Bottom action row */}
            <div className="flex items-center justify-between gap-1.5 pt-1.5 border-t border-white/5">
              <div className="flex items-center gap-1.5 flex-1">
                <div className="flex-1 h-[30px] rounded-lg bg-[#F9DF9F]/15 skeleton-shimmer"></div>
                <div className="w-14 h-[30px] rounded-lg bg-[#1A2242] skeleton-shimmer"></div>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-11 h-[30px] rounded-lg bg-white/5 skeleton-shimmer"></div>
                <div className="w-[30px] h-[30px] rounded-lg bg-white/5 skeleton-shimmer"></div>
                <div className="w-[30px] h-[30px] rounded-lg bg-rose-500/10 skeleton-shimmer"></div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="w-full flex flex-col space-y-2 pb-2">
      {/* Sleek Unified Toolbar: Search + Import Drawer Toggle + Speed Selector */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 flex items-center bg-[#0D1224] rounded-lg border border-white/10 px-2.5 h-[30px] focus-within:border-[#F9DF9F]/50 transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#CDE4E6]/40 shrink-0 mr-1.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={workflows.length > 0 ? `Search ${workflows.length} workflows...` : 'Search workflows...'}
            className="w-full bg-transparent border-none text-[11px] text-[#CDE4E6] placeholder-[#CDE4E6]/40 focus:outline-none"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-[#CDE4E6]/40 hover:text-[#CDE4E6] text-xs ml-1 cursor-pointer">
              ✕
            </button>
          )}
        </div>

        {/* Collapsible Import Drawer Toggle Button */}
        <button
          onClick={() => setShowImport(!showImport)}
          className={`h-[30px] px-2.5 rounded-lg text-[10px] font-bold border transition-all flex items-center gap-1 cursor-pointer shrink-0 active:scale-95 ${
            showImport
              ? 'bg-[#F9DF9F]/20 text-[#F9DF9F] border-[#F9DF9F]/50 shadow-[0_0_8px_rgba(249,223,159,0.2)]'
              : 'bg-[#0D1224] text-[#CDE4E6]/80 hover:text-[#F9DF9F] border-white/10 hover:border-white/20'
          }`}
          title="Import Workflow by ID"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>
          </svg>
          <span>Import</span>
        </button>

        {/* Replay Speed Selector */}
        <select 
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="h-[30px] bg-[#0D1224] text-[#F9DF9F] text-[10px] font-bold rounded-lg border border-white/10 px-1.5 outline-none focus:border-[#F9DF9F]/40 cursor-pointer shrink-0"
          title="Replay Execution Speed"
        >
          <option value={0.5}>0.5x</option>
          <option value={1}>1.0x</option>
          <option value={2}>2.0x</option>
          <option value={5}>5.0x</option>
        </select>
      </div>

      {/* Collapsible Import Drawer */}
      {showImport && (
        <div className="relative p-2 rounded-xl bg-[#0D1224] border border-[#F9DF9F]/35 shadow-lg flex items-center gap-1.5 transition-all">
          <input 
            type="text" 
            value={importId}
            onChange={(e) => setImportId(e.target.value)}
            placeholder="Paste Workflow ID..."
            className="flex-1 px-2.5 h-[28px] text-[11px] bg-[#141A33] rounded-lg border border-white/10 focus:border-[#F9DF9F]/50 focus:outline-none text-[#CDE4E6] placeholder-[#CDE4E6]/40 font-mono"
            autoFocus
          />
          <button 
            onClick={handleImport}
            disabled={!importId.trim()}
            className="h-[28px] px-3 bg-gradient-to-r from-[#F9DF9F] to-[#E9C376] hover:brightness-105 disabled:opacity-40 disabled:hover:brightness-100 text-[#10152B] text-[11px] font-extrabold rounded-lg transition-all shadow-xs cursor-pointer shrink-0"
          >
            Import
          </button>
          <button
            onClick={() => setShowImport(false)}
            className="text-[#CDE4E6]/40 hover:text-[#CDE4E6] p-1 text-xs cursor-pointer"
            title="Cancel"
          >
            ✕
          </button>
        </div>
      )}

      {/* Saved Workflows Subheader */}
      <div className="flex flex-col space-y-2">
        <div className="flex justify-between items-center py-0.5 border-b border-white/5">
          <div className="flex items-center gap-1.5">
            <span className="font-extrabold text-[#F9DF9F] text-xs">Saved Workflows</span>
            <span className="bg-[#F9DF9F]/15 text-[#F9DF9F] text-[10px] font-mono px-2 py-0.2 rounded-full border border-[#F9DF9F]/20 font-bold">
              {searchQuery ? `${filteredWorkflows.length}/${workflows.length}` : workflows.length}
            </span>
          </div>
          
          {workflows.length > 0 && (
            <div className="flex items-center space-x-2">
              {selectedIds.size > 0 && (
                <button 
                  onClick={deleteSelectedWorkflows}
                  className="text-[10px] bg-rose-500/20 hover:bg-rose-500/35 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded-md font-bold transition-all shadow-sm flex items-center gap-1 active:scale-95 cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  Delete ({selectedIds.size})
                </button>
              )}
              <label className="flex items-center space-x-1 cursor-pointer text-[10px] text-[#CDE4E6]/70 hover:text-[#CDE4E6] transition-colors">
                <input 
                  type="checkbox" 
                  checked={selectedIds.size === filteredWorkflows.length && filteredWorkflows.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-white/20 bg-[#0D1224] text-[#F9DF9F] focus:ring-0 cursor-pointer w-3.5 h-3.5"
                />
                <span className="font-medium">Select All</span>
              </label>
            </div>
          )}
        </div>

        {filteredWorkflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center border border-dashed border-white/10 rounded-xl bg-[#0D1224]/60">
            <div className="w-10 h-10 bg-[#F9DF9F]/10 text-[#F9DF9F] rounded-full flex items-center justify-center mb-2.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
            </div>
            <p className="text-xs font-bold text-[#F9DF9F]">
              {searchQuery ? 'No matching workflows' : 'No workflows yet'}
            </p>
            <p className="text-[10px] text-[#CDE4E6]/60 mt-1 max-w-[220px] leading-relaxed">
              {searchQuery
                ? 'Try searching with a different name or clear the search query.'
                : 'Click Record to record your first flow, or open Visual Builder to craft one.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredWorkflows.map(wf => {
              const firstUrl = wf.steps.find((s) => s.url)?.url;
              let domain = '';
              if (firstUrl) {
                try {
                  domain = new URL(firstUrl).hostname.replace('www.', '');
                } catch {
                  // Ignore invalid URL parse
                }
              }

              return (
                <div 
                  key={wf.id} 
                  className={`group relative overflow-hidden rounded-xl p-2.5 border transition-all duration-200 ${
                    selectedIds.has(wf.id) 
                      ? 'bg-[#141A33] border-[#F9DF9F] shadow-[0_0_15px_rgba(249,223,159,0.15)]' 
                      : 'bg-[#141A33]/85 border-white/10 shadow-sm hover:shadow-md hover:border-[#F9DF9F]/40'
                  }`}
                >
                  {/* Active Indicator Line */}
                  <div className={`absolute left-0 top-0 bottom-0 w-1 transition-colors ${selectedIds.has(wf.id) ? 'bg-[#F9DF9F]' : 'bg-transparent group-hover:bg-[#F9DF9F]/40'}`}></div>
                  
                  <div className="flex justify-between items-start ml-1 gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      <input 
                        type="checkbox"
                        checked={selectedIds.has(wf.id)}
                        onChange={() => toggleSelection(wf.id)}
                        className="mt-0.5 rounded border-white/20 bg-[#0D1224] text-[#F9DF9F] focus:ring-0 cursor-pointer shrink-0 w-3.5 h-3.5"
                      />
                      <div className="flex flex-col flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedWorkflowId(expandedWorkflowId === wf.id ? null : wf.id)}>
                        <span className="font-bold text-xs text-[#FFF3D1] group-hover:text-[#F9DF9F] truncate transition-colors" title={wf.name}>{wf.name}</span>
                        <div className="flex flex-wrap items-center text-[10px] text-[#CDE4E6]/60 mt-1 gap-1.5">
                          <span className="flex items-center bg-[#0D1224] text-[#F9DF9F] font-mono px-1.5 py-0.5 rounded text-[9px] border border-white/5 font-semibold shrink-0">
                            ⚡ {wf.steps.length} {wf.steps.length === 1 ? 'step' : 'steps'}
                          </span>
                          {domain && (
                            <span className="flex items-center bg-[#0D1224] text-cyan-300 font-mono px-1.5 py-0.5 rounded text-[9px] border border-cyan-500/20 truncate max-w-[120px] shrink-0" title={firstUrl}>
                              🌐 {domain}
                            </span>
                          )}
                          <span className="text-[9px] text-[#CDE4E6]/40 shrink-0">{new Date(wf.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                    <button 
                      onClick={() => setExpandedWorkflowId(expandedWorkflowId === wf.id ? null : wf.id)}
                      className="text-[#CDE4E6]/50 hover:text-[#CDE4E6] p-1 rounded-md hover:bg-white/5 transition-colors shrink-0"
                      title={expandedWorkflowId === wf.id ? 'Collapse steps' : 'Expand steps'}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transform transition-transform ${expandedWorkflowId === wf.id ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                  </div>

                {errorState?.id === wf.id && (
                  errorState.isRecoveryRequired ? (
                    (() => {
                      const currentStep = wf.steps[errorState.index - 1];
                      const safety = currentStep ? classifyActionSafety(currentStep) : 'EXTERNAL_SIDE_EFFECT';
                      const isUnsafe = safety === 'EXTERNAL_SIDE_EFFECT' || safety === 'TOGGLE_STATE';
                      const session = errorState.session;
                      const evidenceList = session?.recoveryContext?.evidence || [];
                      const stepDetail = currentStep?.sensitive
                        ? '••••••••'
                        : (currentStep?.value || currentStep?.key || (currentStep?.target?.text ? `"${currentStep.target.text}"` : currentStep?.target?.selector) || '');
                      const isUnsafeChecked = !!confirmUnsafeRetry[wf.id];

                      return (
                        <div className="mt-3 ml-8 mr-2 p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-xs text-amber-200 shadow-md">
                          {/* Header */}
                          <div className="flex items-center justify-between pb-2 border-b border-amber-500/20">
                            <span className="font-bold flex items-center gap-2 text-amber-400 text-sm">
                              <span>⚠️</span>
                              Recovery Inspector • Step {errorState.index} of {wf.steps.length}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {errorState.datasetState && (
                                <span className="bg-amber-500/30 text-amber-200 text-[10px] px-2 py-0.5 rounded font-mono font-bold">
                                  Record {errorState.datasetState.currentRecordIndex + 1}/{errorState.datasetState.totalRecords}
                                </span>
                              )}
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${
                                  isUnsafe
                                    ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                }`}
                              >
                                {isUnsafe ? 'Side Effect' : 'Idempotent'}
                              </span>
                            </div>
                          </div>

                          {/* Action Details & Diagnostics */}
                          <div className="mt-2.5 p-2 rounded bg-[#10162A] border border-[#263056] space-y-1.5 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span className="text-[#F9DF9F] font-bold uppercase font-mono">{currentStep?.type || 'ACTION'}</span>
                              <span className="text-[#CDE4E6] font-mono truncate max-w-[280px]" title={stepDetail}>
                                {stepDetail || '(no value/target)'}
                              </span>
                            </div>
                            <div className="text-amber-300/90 text-[11px] leading-relaxed">
                              <strong>Reason:</strong> {errorState.message}
                            </div>
                            {isUnsafe && (
                              <div className="text-red-400 font-semibold text-[10px] flex items-center gap-1.5 pt-0.5">
                                <span>⚠️</span>
                                Warning: Repeating this action may trigger duplicate external side effects.
                              </div>
                            )}
                          </div>

                          {/* Evidence Log */}
                          {evidenceList.length > 0 && (
                            <div className="mt-2.5">
                              <span className="text-[10px] font-bold text-[#CDE4E6]/70 uppercase tracking-wider">
                                Collected Evidence ({evidenceList.length})
                              </span>
                              <div className="mt-1 max-h-24 overflow-y-auto space-y-1 pr-1 font-mono text-[10px]">
                                {evidenceList.map((ev: any, i: number) => (
                                  <div key={ev.id || i} className="flex items-start justify-between p-1.5 rounded bg-black/20 border border-white/5">
                                    <span className="truncate max-w-[240px] text-gray-300">{ev.description}</span>
                                    <span
                                      className={`px-1 rounded text-[9px] font-bold ${
                                        ev.result === 'SUCCESS'
                                          ? 'text-emerald-400 bg-emerald-500/10'
                                          : ev.result === 'UNCERTAIN'
                                          ? 'text-amber-400 bg-amber-500/10'
                                          : 'text-red-400 bg-red-500/10'
                                      }`}
                                    >
                                      {ev.result}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Live Diagnostic Output (Inspection & Recheck) */}
                          {pageInspection && (
                            <div className="mt-2 p-2 rounded bg-[#1A2240] border border-cyan-500/30 text-[11px] text-cyan-200">
                              <div><strong>Current Page URL:</strong> <span className="font-mono">{pageInspection.url}</span></div>
                              <div><strong>Target in DOM:</strong> {pageInspection.targetFound ? '✅ Yes' : '❌ No'}</div>
                            </div>
                          )}
                          {recheckStatus && (
                            <div className="mt-2 p-2 rounded bg-[#1A2240] border border-indigo-500/30 text-[11px] text-indigo-200">
                              <div><strong>Postcondition Recheck:</strong> <span className="font-bold">{recheckStatus.status}</span></div>
                              {recheckStatus.diagnosticInfo && <div>{recheckStatus.diagnosticInfo}</div>}
                            </div>
                          )}

                          {/* Diagnostic Actions */}
                          <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-amber-500/20">
                            <button
                              disabled={recoveryBusy !== null}
                              onClick={() => {
                                setRecoveryBusy('inspect');
                                chrome.runtime.sendMessage(
                                  {
                                    type: 'RECOVERY_INSPECT_PAGE',
                                    payload: { sessionId: session?.sessionId, sessionRevision: session?.sessionRevision },
                                  },
                                  (resp) => {
                                    setRecoveryBusy(null);
                                    if (resp && resp.inspection) {
                                      setPageInspection(resp.inspection);
                                    }
                                  }
                                );
                              }}
                              className="bg-[#263056] hover:bg-[#344275] text-[#CDE4E6] px-2.5 py-1.5 rounded text-[11px] font-semibold border border-[#CDE4E6]/20 transition-colors flex items-center gap-1"
                              title="Safe, read-only inspection of the current URL and DOM target without executing the action"
                            >
                              🔍 {recoveryBusy === 'inspect' ? 'Inspecting...' : 'Inspect Page'}
                            </button>

                            <button
                              disabled={recoveryBusy !== null}
                              onClick={() => {
                                setRecoveryBusy('recheck');
                                chrome.runtime.sendMessage(
                                  {
                                    type: 'RECOVERY_RECHECK_CONDITION',
                                    payload: { sessionId: session?.sessionId, sessionRevision: session?.sessionRevision },
                                  },
                                  (resp) => {
                                    setRecoveryBusy(null);
                                    if (resp && resp.verification) {
                                      setRecheckStatus(resp.verification);
                                    }
                                  }
                                );
                              }}
                              className="bg-indigo-500/20 hover:bg-indigo-500/35 text-indigo-300 px-2.5 py-1.5 rounded text-[11px] font-semibold border border-indigo-500/40 transition-colors flex items-center gap-1"
                              title="Re-evaluates the expected condition against the current DOM without redispatching the action"
                            >
                              🔄 {recoveryBusy === 'recheck' ? 'Rechecking...' : 'Recheck Condition'}
                            </button>
                          </div>

                          {/* Recovery Resolutions */}
                          <div className="mt-3 p-2.5 rounded bg-black/20 border border-white/5 space-y-2">
                            <div className="text-[11px] font-bold text-[#F9DF9F]">Resolution Decisions:</div>

                            {/* Option A: Confirm Success */}
                            <div className="flex items-center justify-between gap-2 p-1.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                              <span className="text-[10px] text-emerald-200">
                                Action succeeded on the page. Advance without repeating.
                              </span>
                              <button
                                onClick={() => {
                                  chrome.runtime.sendMessage({
                                    type: 'RECOVERY_CONFIRM_SUCCESS',
                                    payload: { sessionId: session?.sessionId, sessionRevision: session?.sessionRevision },
                                  });
                                  setErrorState(null);
                                  setPageInspection(null);
                                  setRecheckStatus(null);
                                }}
                                className="bg-emerald-500/25 hover:bg-emerald-500/40 text-emerald-200 px-2.5 py-1 rounded text-[11px] font-bold border border-emerald-500/40 transition-colors shrink-0"
                              >
                                ✅ Confirm Success & Continue
                              </button>
                            </div>

                            {/* Option B: Confirm Failure & Retry */}
                            <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-amber-200">
                                  Action did not take effect. Redispatch with new attempt ID.
                                </span>
                                <button
                                  disabled={isUnsafe && !isUnsafeChecked}
                                  onClick={() => {
                                    chrome.runtime.sendMessage({
                                      type: 'RECOVERY_CONFIRM_FAILURE_RETRY',
                                      payload: {
                                        sessionId: session?.sessionId,
                                        sessionRevision: session?.sessionRevision,
                                        forceUnsafeRetry: isUnsafe ? isUnsafeChecked : false,
                                      },
                                    });
                                    setErrorState(null);
                                    setPageInspection(null);
                                    setRecheckStatus(null);
                                  }}
                                  className={`px-2.5 py-1 rounded text-[11px] font-bold border transition-colors shrink-0 ${
                                    isUnsafe && !isUnsafeChecked
                                      ? 'bg-gray-700/50 text-gray-500 border-gray-600/30 cursor-not-allowed'
                                      : 'bg-amber-500/25 hover:bg-amber-500/40 text-amber-200 border-amber-500/40'
                                  }`}
                                >
                                  🔁 Authorize Retry
                                </button>
                              </div>
                              {isUnsafe && (
                                <label className="flex items-center gap-2 cursor-pointer text-[10px] text-red-300 select-none pt-1">
                                  <input
                                    type="checkbox"
                                    checked={isUnsafeChecked}
                                    onChange={(e) =>
                                      setConfirmUnsafeRetry((prev) => ({
                                        ...prev,
                                        [wf.id]: e.target.checked,
                                      }))
                                    }
                                    className="rounded border-red-500/50 bg-[#1A2240] text-amber-400 focus:ring-0"
                                  />
                                  <span>I understand this action has side effects and confirm I want to retry.</span>
                                </label>
                              )}
                            </div>

                            {/* Dataset Record Controls & Stop Replay */}
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                              {errorState.datasetState ? (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={() => {
                                      chrome.runtime.sendMessage({ type: 'SKIP_RECORD', payload: { sessionId: session?.sessionId } });
                                      setErrorState(null);
                                    }}
                                    className="bg-indigo-500/25 hover:bg-indigo-500/40 text-indigo-300 px-2 py-1 rounded text-[10px] font-bold border border-indigo-500/40 transition-colors"
                                    title="Skip current dataset record and continue next record"
                                  >
                                    Skip Record
                                  </button>
                                  <button
                                    onClick={() => {
                                      chrome.runtime.sendMessage({
                                        type: 'RETRY_RECORD',
                                        payload: { sessionId: session?.sessionId, options: { forceUnsafeRetry: isUnsafeChecked } },
                                      });
                                      setErrorState(null);
                                    }}
                                    className="bg-cyan-500/25 hover:bg-cyan-500/40 text-cyan-300 px-2 py-1 rounded text-[10px] font-bold border border-cyan-500/40 transition-colors"
                                    title="Restart current dataset record from step 1"
                                  >
                                    Restart Record
                                  </button>
                                </div>
                              ) : <div />}

                              <button
                                onClick={() => {
                                  chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW', payload: { sessionId: session?.sessionId } });
                                  setErrorState(null);
                                  setPageInspection(null);
                                  setRecheckStatus(null);
                                }}
                                className="text-red-400 hover:text-red-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors"
                              >
                                ⏹ Stop Replay
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div className="mt-3 ml-8 mr-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                      <div className="flex items-center justify-between">
                        <span className="font-bold flex items-center gap-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                          Failed at Step {errorState.index}
                        </span>
                        {errorState.datasetState && (
                          <span className="bg-red-500/30 text-red-200 text-[10px] px-1.5 py-0.5 rounded font-mono">
                            Rec {errorState.datasetState.currentRecordIndex + 1}/{errorState.datasetState.totalRecords}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 opacity-80 break-words">
                        {errorState.message.includes('TARGET_NOT_FOUND') 
                          ? 'Could not find the element on the page. It may have changed or taken too long to load.' 
                          : errorState.message}
                      </p>
                      {errorState.datasetState && (
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => {
                              chrome.runtime.sendMessage({ type: 'SKIP_RECORD' });
                              setErrorState(null);
                            }}
                            className="bg-indigo-500/25 hover:bg-indigo-500/40 text-indigo-300 px-2 py-1 rounded text-[10px] font-bold border border-indigo-500/40 transition-colors"
                          >
                            Skip Record
                          </button>
                          <button
                            onClick={() => {
                              chrome.runtime.sendMessage({ type: 'RETRY_RECORD' });
                              setErrorState(null);
                            }}
                            className="bg-cyan-500/25 hover:bg-cyan-500/40 text-cyan-300 px-2 py-1 rounded text-[10px] font-bold border border-cyan-500/40 transition-colors"
                          >
                            Retry Record
                          </button>
                        </div>
                      )}
                    </div>
                  )
                )}

                <div className="flex items-center justify-between gap-1.5 mt-2 pt-2 border-t border-white/5">
                  {/* Primary Actions Group (Run & Build) */}
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <button 
                      onClick={() => playWorkflow(wf)}
                      disabled={playingWorkflowId === wf.id}
                      className="flex-1 h-[30px] flex items-center justify-center gap-1.5 bg-gradient-to-r from-[#F9DF9F] via-[#F5D792] to-[#E9C376] hover:brightness-105 disabled:opacity-50 text-[#10152B] px-2.5 rounded-lg text-xs font-extrabold transition-all shadow-sm active:scale-95 cursor-pointer shrink-0"
                    >
                      {playingWorkflowId === wf.id ? (
                        <>
                          <svg className="animate-spin h-3 w-3 text-[#10152B] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="truncate max-w-[70px]">
                            {runningProgress 
                              ? `[${runningProgress.index}/${runningProgress.total}]` 
                              : 'Running...'}
                          </span>
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="shrink-0"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          <span>Run</span>
                        </>
                      )}
                    </button>
                    <button 
                      onClick={() => onOpenBuilder?.(wf)}
                      className="h-[30px] flex items-center justify-center gap-1 bg-[#1A2242] hover:bg-[#232D56] text-[#F9DF9F] hover:text-[#FFF0C2] px-2.5 rounded-lg text-xs font-bold transition-all active:scale-95 border border-[#F9DF9F]/30 hover:border-[#F9DF9F]/60 shadow-xs cursor-pointer shrink-0"
                      title="Edit in Visual Workflow Builder"
                    >
                      <span className="text-[11px]">🛠️</span>
                      <span>Build</span>
                    </button>
                  </div>

                  {/* Secondary Tools Group: Data, Share, Delete */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button 
                      onClick={() => openDataModal(wf)}
                      disabled={playingWorkflowId === wf.id}
                      className="h-[30px] flex items-center justify-center gap-1 bg-[#0D1224] hover:bg-white/10 text-[#CDE4E6] px-2 rounded-lg text-[11px] font-semibold transition-all active:scale-95 border border-white/10 hover:border-white/20 cursor-pointer"
                      title="Run with custom variables or dataset"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#CDE4E6]/70"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                      <span>Data</span>
                    </button>
                    <button 
                      onClick={() => shareWorkflow(wf.id)}
                      className="h-[30px] w-[30px] flex items-center justify-center bg-[#0D1224] hover:bg-white/10 text-[#CDE4E6] rounded-lg transition-all active:scale-95 border border-white/10 hover:border-white/20 cursor-pointer"
                      title="Copy Workflow ID to share"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
                    </button>
                    <button 
                      onClick={() => deleteWorkflow(wf.id)}
                      className="h-[30px] w-[30px] flex items-center justify-center bg-[#0D1224] hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 rounded-lg transition-all active:scale-95 border border-rose-500/20 hover:border-rose-500/40 cursor-pointer"
                      title="Delete workflow"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>

                {expandedWorkflowId === wf.id && (
                  <div className="mt-3 ml-8 mr-2 bg-[#0C1226] rounded border border-[#CDE4E6]/10 overflow-hidden">
                    <div className="max-h-48 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                      {wf.steps.map((step, idx) => {
                        const isErrorStep = errorState?.id === wf.id && errorState.index === idx + 1;
                        const isRunningStep = playingWorkflowId === wf.id && runningProgress?.index === idx + 1;
                        
                        return (
                          <div 
                            key={idx} 
                            className={`flex items-start text-[10px] sm:text-xs p-1.5 rounded ${
                              isErrorStep 
                                ? 'bg-red-500/20 text-red-400 border border-red-500/30' 
                                : isRunningStep 
                                  ? 'bg-[#F9DF9F]/20 text-[#F9DF9F] border border-[#F9DF9F]/30' 
                                  : 'text-[#CDE4E6]/80 hover:bg-[#263056]'
                            }`}
                          >
                            <span className="opacity-50 w-4 font-mono">{idx + 1}.</span>
                            <span className="font-bold uppercase tracking-wider w-16 opacity-90">{step.type}</span>
                            <span className="flex-1 truncate ml-2 font-mono text-[#CDE4E6]/60">
                              {step.sensitive ? '••••••••' : (step.value || step.key || (step.target?.text ? `"${step.target.text}"` : step.target?.selector) || 'No details')}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>

      {/* Phase 7: Dataset & Runtime Variables Modal */}
      {modalWorkflow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-sm max-h-[90vh] flex flex-col bg-[#1A2240] border border-[#CDE4E6]/20 rounded-xl shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#CDE4E6]/15 bg-[#0C1226]/50">
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#F9DF9F]"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                <span className="font-bold text-sm text-[#F9DF9F] truncate max-w-[200px]">{modalWorkflow.name}</span>
              </div>
              <button 
                onClick={closeModal}
                className="text-[#CDE4E6]/60 hover:text-[#CDE4E6] p-1 rounded-md transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar text-xs">
              {/* Variables Section */}
              {modalWorkflow.variables && modalWorkflow.variables.length > 0 && (
                <div className="space-y-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[#CDE4E6]/80 flex items-center gap-1.5">
                    <span>🔤</span> Runtime Variables
                  </span>
                  <div className="space-y-2">
                    {modalWorkflow.variables.map(v => (
                      <div key={v.name} className="flex flex-col space-y-1 bg-[#263056]/60 p-2 rounded-lg border border-[#CDE4E6]/10">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#F9DF9F]">{v.name}</span>
                          <span className="text-[10px] bg-[#0C1226] text-[#CDE4E6]/60 px-1.5 py-0.5 rounded font-mono">{v.type || 'string'}</span>
                        </div>
                        {v.description && <span className="text-[10px] text-[#CDE4E6]/60">{v.description}</span>}
                        {v.type === 'boolean' ? (
                          <label className="flex items-center gap-2 cursor-pointer mt-1">
                            <input 
                              type="checkbox"
                              checked={Boolean(modalVariables[v.name])}
                              onChange={(e) => setModalVariables({ ...modalVariables, [v.name]: e.target.checked })}
                              className="rounded border-[#CDE4E6]/30 bg-[#1A2240] text-[#F9DF9F]"
                            />
                            <span className="text-[11px] text-[#CDE4E6]">{modalVariables[v.name] ? 'True' : 'False'}</span>
                          </label>
                        ) : (
                          <input 
                            type={v.sensitive ? 'password' : (v.type === 'number' ? 'number' : 'text')}
                            value={modalVariables[v.name] ?? ''}
                            placeholder={v.defaultValue !== undefined ? String(v.defaultValue) : ''}
                            onChange={(e) => setModalVariables({
                              ...modalVariables,
                              [v.name]: v.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value
                            })}
                            className="px-2.5 py-1.5 bg-[#0C1226] border border-[#CDE4E6]/20 rounded text-[#CDE4E6] text-xs focus:outline-none focus:border-[#F9DF9F]"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Dataset Section */}
              <div className="space-y-2 border-t border-[#CDE4E6]/10 pt-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs uppercase tracking-wider text-[#CDE4E6]/80 flex items-center gap-1.5">
                    <span>📊</span> Dataset (Batch Run)
                  </span>
                  <div className="flex gap-1 text-[10px]">
                    <button 
                      onClick={() => handleDatasetFormatChange('csv')}
                      className={`px-2 py-0.5 rounded ${datasetFormat === 'csv' ? 'bg-[#F9DF9F] text-[#263056] font-bold' : 'bg-[#263056] text-[#CDE4E6]/60'}`}
                    >
                      CSV
                    </button>
                    <button 
                      onClick={() => handleDatasetFormatChange('json')}
                      className={`px-2 py-0.5 rounded ${datasetFormat === 'json' ? 'bg-[#F9DF9F] text-[#263056] font-bold' : 'bg-[#263056] text-[#CDE4E6]/60'}`}
                    >
                      JSON
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <label className="flex-1 flex items-center justify-center gap-1.5 bg-[#263056] hover:bg-[#1A2240] text-[#CDE4E6] px-3 py-1.5 rounded border border-[#CDE4E6]/20 cursor-pointer font-medium text-[11px] transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                    Upload {datasetFormat.toUpperCase()}
                    <input 
                      type="file" 
                      accept={datasetFormat === 'csv' ? '.csv,text/csv' : '.json,application/json'}
                      onChange={handleDatasetFileUpload}
                      className="hidden" 
                    />
                  </label>
                  {datasetContent && (
                    <button 
                      onClick={clearDataset}
                      className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <textarea 
                  rows={4}
                  value={datasetContent}
                  onChange={(e) => handleDatasetContentChange(e.target.value)}
                  placeholder={datasetFormat === 'csv' ? "username,company\nalice,Acme\nbob,Globex" : '[{"username":"alice"},{"username":"bob"}]'}
                  className="w-full px-2.5 py-1.5 font-mono text-[11px] bg-[#0C1226] border border-[#CDE4E6]/20 rounded text-[#CDE4E6] focus:outline-none focus:border-[#F9DF9F] custom-scrollbar"
                />

                {datasetParsed && (
                  <div className="p-2 bg-emerald-500/15 border border-emerald-500/30 rounded text-[11px] text-emerald-300">
                    <span className="font-bold flex items-center gap-1 text-emerald-400">
                      <span>✓</span> {datasetParsed.rowCount} records ready
                    </span>
                    <p className="mt-0.5 text-[10px] opacity-80 truncate">
                      Columns: {datasetParsed.columns.join(', ')}
                    </p>
                  </div>
                )}

                {datasetError && (
                  <div className="p-2 bg-red-500/15 border border-red-500/30 rounded text-[11px] text-red-400">
                    <span className="font-bold">Invalid Dataset</span>
                    <p className="mt-0.5 text-[10px] opacity-90 break-words">{datasetError}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#CDE4E6]/15 bg-[#0C1226]/50">
              <button 
                onClick={closeModal}
                className="px-3 py-1.5 bg-[#263056] hover:bg-[#1A2240] text-[#CDE4E6] rounded-lg text-xs font-semibold border border-[#CDE4E6]/20 transition-colors"
              >
                Cancel
              </button>
              {datasetParsed && datasetParsed.rowCount > 0 ? (
                <button 
                  onClick={startDatasetExecution}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056] rounded-lg text-xs font-bold transition-all shadow-sm active:scale-95"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Run Dataset ({datasetParsed.rowCount})
                </button>
              ) : (
                <button 
                  onClick={startSingleExecutionWithVariables}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056] rounded-lg text-xs font-bold transition-all shadow-sm active:scale-95"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Run Workflow
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
