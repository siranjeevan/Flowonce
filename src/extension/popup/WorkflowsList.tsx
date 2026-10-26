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
  const [importId, setImportId] = useState('');
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

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-10 space-y-3">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Loading your workflows...</p>
    </div>
  );

  return (
    <div className="w-full flex flex-col space-y-6 pb-2">
      {/* Import Section */}
      <div className="relative group">
        <div className="absolute -inset-0.5 bg-gradient-to-r from-[#F9DF9F] to-[#e6cc8e] rounded-lg blur opacity-10 group-hover:opacity-30 transition duration-200"></div>
        <div className="relative flex items-center bg-[#1A2240] rounded-lg shadow-sm border border-[#CDE4E6]/20 overflow-hidden focus-within:ring-2 focus-within:ring-[#F9DF9F]">
          <div className="pl-3 text-[#CDE4E6]/50">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          </div>
          <input 
            type="text" 
            value={importId}
            onChange={(e) => setImportId(e.target.value)}
            placeholder="Paste Workflow ID to import..."
            className="flex-1 px-3 py-2.5 text-sm bg-transparent border-none focus:outline-none text-[#CDE4E6] placeholder-[#CDE4E6]/40"
          />
          <button 
            onClick={handleImport}
            disabled={!importId.trim()}
            className="px-4 py-2.5 bg-[#F9DF9F] hover:bg-[#e6cc8e] disabled:bg-[#1A2240] disabled:text-[#CDE4E6]/40 text-[#263056] text-sm font-bold transition-colors"
          >
            Import
          </button>
        </div>
      </div>
      
      <div className="flex flex-col space-y-3">
        <div className="flex justify-between items-end pb-1 border-b border-[#CDE4E6]/20">
          <h3 className="font-bold text-[#F9DF9F] text-sm flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#CDE4E6]"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            Saved Workflows
            <span className="bg-[#F9DF9F]/20 text-[#F9DF9F] py-0.5 px-2 rounded-full text-[10px]">{workflows.length}</span>
          </h3>
          
          {workflows.length > 0 && (
            <div className="flex items-center space-x-3">
              <select 
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="bg-[#1A2240] text-[#CDE4E6] text-[10px] rounded border border-[#CDE4E6]/20 py-0.5 px-1 outline-none focus:border-[#F9DF9F]"
                title="Playback Speed"
              >
                <option value={0.5}>0.5x Speed</option>
                <option value={1}>1x Speed</option>
                <option value={2}>2x Speed</option>
                <option value={5}>5x Fast</option>
              </select>

              <label className="flex items-center space-x-1.5 cursor-pointer text-xs text-[#CDE4E6]/70 hover:text-[#CDE4E6] transition-colors">
                <input 
                  type="checkbox" 
                  checked={selectedIds.size === workflows.length && workflows.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-[#CDE4E6]/30 bg-[#1A2240] text-[#F9DF9F] focus:ring-[#F9DF9F]"
                />
                <span className="font-medium">All</span>
              </label>
              {selectedIds.size > 0 && (
                <button 
                  onClick={deleteSelectedWorkflows}
                  className="text-[10px] bg-red-500/20 hover:bg-red-500/40 text-red-400 px-2 py-1 rounded-md font-bold transition-all shadow-sm flex items-center gap-1"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                  Delete ({selectedIds.size})
                </button>
              )}
            </div>
          )}
        </div>

        {workflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center border border-dashed border-[#CDE4E6]/20 rounded-xl bg-[#1A2240]/50">
            <div className="w-12 h-12 bg-[#F9DF9F]/10 text-[#F9DF9F] rounded-full flex items-center justify-center mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
            </div>
            <p className="text-sm font-semibold text-[#CDE4E6]">No workflows yet</p>
            <p className="text-xs text-[#CDE4E6]/60 mt-1 max-w-[200px]">Record your first workflow or import one to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {workflows.map(wf => (
              <div 
                key={wf.id} 
                className={`group relative overflow-hidden rounded-xl p-3 border transition-all duration-200 ${
                  selectedIds.has(wf.id) 
                    ? 'bg-[#1A2240] border-[#F9DF9F] shadow-sm' 
                    : 'bg-[#1A2240] border-[#CDE4E6]/10 shadow-sm hover:shadow-md hover:border-[#F9DF9F]/50'
                }`}
              >
                {/* Active Indicator Line */}
                <div className={`absolute left-0 top-0 bottom-0 w-1 transition-colors ${selectedIds.has(wf.id) ? 'bg-[#F9DF9F]' : 'bg-transparent group-hover:bg-[#F9DF9F]/50'}`}></div>
                
                <div className="flex justify-between items-start ml-2">
                  <div className="flex items-start space-x-3">
                    <input 
                      type="checkbox"
                      checked={selectedIds.has(wf.id)}
                      onChange={() => toggleSelection(wf.id)}
                      className="mt-1 rounded border-[#CDE4E6]/30 bg-[#263056] text-[#F9DF9F] focus:ring-[#F9DF9F] transition-colors"
                    />
                    <div className="flex flex-col cursor-pointer" onClick={() => setExpandedWorkflowId(expandedWorkflowId === wf.id ? null : wf.id)}>
                      <span className="font-semibold text-sm text-[#F9DF9F] truncate max-w-[170px] hover:underline">{wf.name}</span>
                      <div className="flex items-center text-[10px] text-[#CDE4E6]/60 mt-0.5 space-x-2">
                        <span className="flex items-center bg-[#263056] px-1.5 py-0.5 rounded">
                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                          {wf.steps.length} steps
                        </span>
                        <span>{new Date(wf.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => setExpandedWorkflowId(expandedWorkflowId === wf.id ? null : wf.id)}
                    className="text-[#CDE4E6]/50 hover:text-[#CDE4E6] p-1 rounded-md hover:bg-[#263056] transition-colors"
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

                <div className="flex space-x-2 mt-3 ml-8 mr-2">
                  <button 
                    onClick={() => playWorkflow(wf)}
                    disabled={playingWorkflowId === wf.id}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-[#F9DF9F] hover:bg-[#e6cc8e] disabled:bg-[#F9DF9F]/60 text-[#263056] py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all shadow-sm hover:shadow active:scale-95"
                  >
                    {playingWorkflowId === wf.id ? (
                      <>
                        <svg className="animate-spin h-3 w-3 text-[#263056] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span className="truncate max-w-[80px] sm:max-w-[120px]">
                          {runningProgress 
                            ? `[${runningProgress.index}/${runningProgress.total}] ${runningProgress.type}` 
                            : 'Running...'}
                        </span>
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Run
                      </>
                    )}
                  </button>
                  <button 
                    onClick={() => onOpenBuilder?.(wf)}
                    className="flex items-center justify-center gap-1 bg-[#263056] hover:bg-[#1A2240] text-[#F9DF9F] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 border border-[#F9DF9F]/30"
                    title="Edit in Visual Workflow Builder"
                  >
                    🛠️ Build
                  </button>
                  <button 
                    onClick={() => openDataModal(wf)}
                    disabled={playingWorkflowId === wf.id}
                    className="flex items-center justify-center gap-1 bg-[#263056] hover:bg-[#1A2240] text-[#CDE4E6] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 border border-[#CDE4E6]/20"
                    title="Run with custom variables or dataset"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                    Data
                  </button>
                  <button 
                    onClick={() => shareWorkflow(wf.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-[#263056] hover:bg-[#1A2240] text-[#CDE4E6] py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 border border-[#CDE4E6]/20"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
                    Share
                  </button>
                  <button 
                    onClick={() => deleteWorkflow(wf.id)}
                    className="w-8 flex items-center justify-center bg-[#263056] hover:bg-red-500/20 text-red-400 py-1.5 rounded-lg transition-colors active:scale-95 border border-red-500/20"
                    title="Delete workflow"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
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
            ))}
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
