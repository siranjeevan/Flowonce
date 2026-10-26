import { useState, useEffect } from 'react';
import type { WorkflowStep, Workflow } from '../../shared/types/workflow';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { FirestoreStorageManager } from '../../workflow/storage/firestore-storage';
import { LEGACY_STORAGE_KEYS } from '../../workflow/storage/storage-keys';
import { Auth } from './Auth';
import { WorkflowsList } from './WorkflowsList';
import { VisualWorkflowBuilder } from '../builder/VisualWorkflowBuilder';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from '../../firebase/config';
import logoImg from '../../assets/image.png';

type AppTab = 'record' | 'workflows';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isLocalMode, setIsLocalMode] = useState(
    () => new URLSearchParams(window.location.search).get('mode') === 'local'
  );
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('workflows');
  const [workflowName, setWorkflowName] = useState('');
  const [builderWorkflow, setBuilderWorkflow] = useState<Workflow | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'builder' && !params.get('workflowId')) {
      return {
        id: `WF_BUILDER_${Date.now().toString(36).toUpperCase()}`,
        name: 'New Visual Workflow',
        description: 'Created via Visual Workflow Builder',
        ownerId: 'local_user',
        version: 1,
        schemaVersion: 2,
        steps: [],
        variables: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return null;
  });

  const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Check URL query parameters for direct builder deep-linking with specific workflowId
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const wfId = params.get('workflowId');

    if (view === 'builder' && wfId) {
      WorkflowStorage.getWorkflow(wfId).then((wf) => {
        if (wf) {
          setBuilderWorkflow(wf);
        } else {
          // Create fallback default workflow with this ID
          setBuilderWorkflow({
            id: wfId,
            name: 'New Custom Workflow',
            description: 'Created via Visual Workflow Builder',
            ownerId: 'local_user',
            version: 1,
            schemaVersion: 2,
            steps: [],
            variables: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      });
    }
  }, []);

  useEffect(() => {
    // Initial state load
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
        if (response) {
          setIsRecording(response.isRecording);
          if (response.steps) setSteps(response.steps);
        }
      });

      const listener = (message: any) => {
        if (message.type === 'STEP_ADDED') {
          setSteps((prev) => [...prev, message.payload]);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    // Sync workflows saved locally from the content script modal up to the cloud
    const syncLocalWorkflows = async () => {
      try {
        const localWorkflows = await WorkflowStorage.getAllWorkflows();

        if (localWorkflows.length > 0) {
          console.log(`Syncing ${localWorkflows.length} local workflows to cloud...`);
          for (const wf of localWorkflows) {
            // Ensure ownerId is set to the real user before uploading
            const cloudWf = { ...wf, ownerId: user.uid };
            await FirestoreStorageManager.saveWorkflow(cloudWf);
          }
          // Clear local and legacy keys after successful sync
          await WorkflowStorage.replaceAllWorkflows([]);
          try {
            await chrome.storage.local.remove([
              LEGACY_STORAGE_KEYS.LEGACY_WORKFLOWS,
              LEGACY_STORAGE_KEYS.LEGACY_FLOWONCE_WORKFLOWS,
            ]);
          } catch {
            // Ignore if keys do not exist or chrome.storage is unavailable
          }
          showNotification(`Synced ${localWorkflows.length} offline workflow(s) to cloud!`, 'success');
        }
      } catch (err) {
        console.error('Failed to sync local workflows to cloud:', err);
      }
    };

    syncLocalWorkflows();
  }, [user]);

  const toggleRecording = async () => {
    const newState = !isRecording;

    if (typeof chrome === 'undefined' || !chrome.tabs) {
      setIsRecording(newState);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: newState ? 'START_RECORDING' : 'STOP_RECORDING',
      });
    } catch (e) {
      console.error('Could not send message to tab.', e);
      if (newState) {
        showNotification('Cannot connect to page. Refresh the webpage and try again.', 'error');
        return;
      }
    }

    await chrome.runtime.sendMessage({ type: 'SET_RECORDING_STATE', payload: newState });
    setIsRecording(newState);

    if (newState) {
      setSteps([]);
    } else {
      if (steps.length === 0) {
        showNotification('No steps were recorded.', 'error');
      }
    }
  };

  const saveWorkflow = async () => {
    if (steps.length === 0) return;

    const workflow: Workflow = {
      id: `WF_${Date.now().toString(36).toUpperCase()}`,
      name: workflowName.trim() || `Workflow ${new Date().toLocaleString()}`,
      description: 'Recorded workflow',
      ownerId: user?.uid || 'local_user',
      version: 1,
      schemaVersion: 2,
      steps: [...steps],
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await WorkflowStorage.createWorkflow(workflow);
      if (user) {
        await FirestoreStorageManager.saveWorkflow(workflow);
        showNotification('Workflow saved to Cloud successfully!');
      } else {
        showNotification('Workflow saved locally (not logged in).');
      }
      setSteps([]);
      setWorkflowName('');
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CLEAR_RECORDED_STEPS' });
      }
      setActiveTab('workflows');
    } catch (e: any) {
      console.error('Failed to save workflow', e);
      showNotification(`Error: ${e.message || 'Unknown error'}`, 'error');
    }
  };

  const createBlankWorkflow = () => {
    const newWf: Workflow = {
      id: `WF_${Date.now().toString(36).toUpperCase()}`,
      name: 'Untitled Visual Workflow',
      description: 'Built with FlowOnce Visual Workflow Builder',
      ownerId: user?.uid || 'local_user',
      version: 1,
      schemaVersion: 2,
      steps: [
        {
          id: `step_${Date.now().toString(36)}_0`,
          type: 'navigate',
          timestamp: 1000,
          url: 'https://example.com',
          sequence: 0,
          description: 'Navigate to target page',
          layout: { x: 100, y: 100 },
        },
      ],
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setBuilderWorkflow(newWf);
  };

  // If Visual Workflow Builder is active, render full-window builder canvas!
  if (builderWorkflow) {
    return (
      <div className="w-full h-screen min-h-screen bg-[#1e2642] text-[#CDE4E6] flex flex-col font-sans">
        <VisualWorkflowBuilder
          initialWorkflow={builderWorkflow}
          onClose={() => setBuilderWorkflow(null)}
          onSave={(_saved) => {
            setBuilderWorkflow(null);
            showNotification('Workflow saved successfully!');
            setActiveTab('workflows');
          }}
          currentUserId={user?.uid || 'local_user'}
        />
      </div>
    );
  }

  return (
    <div className="w-[375px] max-w-full min-h-[520px] max-h-[600px] bg-gradient-to-b from-[#141A33] via-[#10152B] to-[#0B0F1F] text-[#CDE4E6] flex flex-col font-sans select-none shadow-2xl">
      {/* Modern Frosted Glass Header */}
      <header className="px-3.5 py-2.5 border-b border-[#F9DF9F]/15 bg-[#161D36]/85 backdrop-blur-md text-[#F9DF9F] shadow-sm flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center">
            <img
              src={logoImg}
              alt="FlowOnce Logo"
              className="w-5.5 h-5.5 object-contain drop-shadow-[0_2px_8px_rgba(249,223,159,0.35)]"
              style={{ mixBlendMode: 'screen' }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-sm font-extrabold tracking-tight bg-gradient-to-r from-[#FFF2CF] via-[#F9DF9F] to-[#E3BD66] bg-clip-text text-transparent">
              FlowOnce
            </h1>
            <span className="text-[9px] bg-[#1A2242] text-[#38bdf8] font-mono px-1.5 py-0.5 rounded-full font-bold border border-[#38bdf8]/40 shadow-[0_0_8px_rgba(56,189,248,0.2)]">
              PRO
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <button
              onClick={() => signOut(auth)}
              className="text-[11px] text-[#CDE4E6]/70 hover:text-[#F9DF9F] transition-colors font-medium px-2 py-0.5 rounded-md hover:bg-white/5 cursor-pointer"
              title="Sign out of your account"
            >
              Sign out
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Offline Ready
            </span>
          )}
        </div>
      </header>

      {/* Floating Alert Notification */}
      {notification && (
        <div className="px-3 pt-2">
          <div
            className={`px-3 py-2 text-center text-xs font-semibold rounded-lg shadow-lg backdrop-blur-md transition-all animate-in fade-in duration-200 flex items-center justify-center gap-1.5 ${
              notification.type === 'success'
                ? 'bg-emerald-950/80 text-emerald-200 border border-emerald-500/40 shadow-emerald-950/30'
                : 'bg-rose-950/80 text-rose-200 border border-rose-500/40 shadow-rose-950/30'
            }`}
          >
            <span>{notification.type === 'success' ? '✓' : '⚠️'}</span>
            <span>{notification.message}</span>
          </div>
        </div>
      )}

      <main className="flex-1 p-3 flex flex-col items-center justify-start overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="w-full flex flex-col space-y-2.5 animate-in fade-in duration-200">
            {/* Nav Skeleton */}
            <div className="w-full h-8 rounded-xl bg-[#0D1224] border border-white/5 skeleton-shimmer"></div>
            {/* Subheader Skeleton */}
            <div className="flex justify-between items-center py-1">
              <div className="w-28 h-3.5 rounded bg-white/10 skeleton-shimmer"></div>
              <div className="w-24 h-7 rounded-lg bg-[#F9DF9F]/15 skeleton-shimmer"></div>
            </div>
            {/* Card Skeletons */}
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="rounded-xl p-2.5 bg-[#141A33]/70 border border-white/5 space-y-2 shadow-sm">
                  <div className="flex items-start gap-2">
                    <div className="w-3.5 h-3.5 rounded bg-white/10 skeleton-shimmer mt-0.5"></div>
                    <div className="flex-1 space-y-1.5">
                      <div className={`h-3 rounded bg-white/10 skeleton-shimmer ${i === 1 ? 'w-3/4' : 'w-2/3'}`}></div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-2.5 rounded bg-[#F9DF9F]/10 skeleton-shimmer"></div>
                        <div className="w-16 h-2.5 rounded bg-cyan-400/10 skeleton-shimmer"></div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-1.5 pt-1.5 border-t border-white/5">
                    <div className="flex-1 h-[30px] rounded-lg bg-[#F9DF9F]/15 skeleton-shimmer"></div>
                    <div className="w-14 h-[30px] rounded-lg bg-[#1A2242] skeleton-shimmer"></div>
                    <div className="w-11 h-[30px] rounded-lg bg-white/5 skeleton-shimmer"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : !user && !isLocalMode ? (
          <Auth onAuthSuccess={() => setIsLocalMode(true)} />
        ) : (
          <>
            {/* Sleek Segmented Pill Navigation */}
            <div className="w-full flex p-1 bg-[#0D1224] rounded-xl mb-2.5 text-xs font-semibold border border-white/5 shadow-inner">
              {[
                { id: 'workflows', label: 'Workflows', icon: '📁' },
                { id: 'record', label: 'Record', icon: '⚡' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as AppTab)}
                  className={`flex-1 py-1.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 font-bold cursor-pointer ${
                    activeTab === tab.id
                      ? 'bg-gradient-to-r from-[#F9DF9F] to-[#E9C376] shadow-[0_2px_12px_rgba(249,223,159,0.3)] text-[#10152B]'
                      : 'text-[#CDE4E6]/65 hover:text-[#CDE4E6] hover:bg-white/5'
                  }`}
                >
                  <span className="text-xs">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* TAB: WORKFLOWS */}
            {activeTab === 'workflows' && (
              <div className="w-full flex flex-col space-y-2">
                <div className="flex items-center justify-between px-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F9DF9F]/70"></span>
                    <span className="text-[11px] font-semibold text-[#CDE4E6]/75 uppercase tracking-wider">Visual Builder & Replays</span>
                  </div>
                  <button
                    onClick={createBlankWorkflow}
                    className="h-7 px-2.5 rounded-lg bg-gradient-to-r from-[#F9DF9F] to-[#E9C376] text-[#12172B] text-[11px] font-extrabold hover:brightness-105 transition-all shadow-[0_2px_8px_rgba(249,223,159,0.25)] flex items-center gap-1 active:scale-95 cursor-pointer shrink-0"
                    title="Design a new visual automation flow from scratch"
                  >
                    <span>🛠️</span> + Visual Builder
                  </button>
                </div>
                <WorkflowsList
                  user={user}
                  onOpenBuilder={(wf) => setBuilderWorkflow(wf)}
                />
              </div>
            )}

            {/* TAB: RECORD */}
            {activeTab === 'record' && (
              <div className="w-full flex flex-col space-y-3">
                {/* Status Hero Card */}
                <div className="p-3 rounded-xl bg-[#141A33]/80 border border-white/5 text-center flex flex-col items-center shadow-md">
                  <div className="w-8 h-8 rounded-full bg-[#F9DF9F]/10 flex items-center justify-center text-sm mb-1.5 text-[#F9DF9F]">
                    {isRecording ? '⏺️' : '🎯'}
                  </div>
                  <p className="text-xs font-bold text-[#F9DF9F]">
                    {isRecording ? 'Recording Live Interactions' : 'Interactive Workflow Recorder'}
                  </p>
                  <p className="text-[10px] text-[#CDE4E6]/60 mt-0.5 max-w-[260px] leading-relaxed">
                    {isRecording
                      ? 'Perform actions in your active tab. Each click, typing, or navigation is captured.'
                      : 'Record actions once. Inspect and replay anytime with high reliability.'}
                  </p>
                  <div className="mt-2 inline-flex items-center gap-1.5 text-[9px] text-[#CDE4E6]/50 bg-[#0B0F1F] px-2.5 py-0.5 rounded-full border border-white/5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                    <span>{user?.email ? user.email : 'Local Sandbox Mode'}</span>
                  </div>
                </div>

                {/* Big Tactile Record Action Button */}
                <button
                  onClick={toggleRecording}
                  className={`w-full py-3 rounded-xl font-bold text-xs shadow-lg transition-all flex items-center justify-center space-x-2 active:scale-[0.98] ${
                    isRecording
                      ? 'bg-gradient-to-r from-red-600 to-rose-500 text-white animate-record-pulse shadow-red-900/40 hover:from-red-500 hover:to-rose-400'
                      : 'bg-gradient-to-r from-[#F9DF9F] via-[#F4D58D] to-[#E5BD64] hover:brightness-105 text-[#10152B] shadow-[0_4px_16px_rgba(249,223,159,0.3)]'
                  }`}
                >
                  {isRecording ? (
                    <>
                      <span className="w-3 h-3 rounded-sm bg-white animate-pulse"></span>
                      <span className="tracking-wide">Stop Recording ({steps.length} Steps)</span>
                    </>
                  ) : (
                    <>
                      <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping mr-1"></span>
                      <span className="tracking-wide">● Start Recording Interactions</span>
                    </>
                  )}
                </button>

                {steps.length > 0 && (
                  <div className="w-full mt-2 flex flex-col space-y-2.5 bg-[#141A33]/50 p-3 rounded-xl border border-white/5">
                    <div className="flex justify-between items-center border-b border-[#F9DF9F]/15 pb-2">
                      <span className="text-xs font-bold text-[#F9DF9F] flex items-center gap-1.5">
                        <span>Captured Actions</span>
                        <span className="bg-[#10152B] text-[10px] font-mono px-1.5 py-0.5 rounded-full text-[#38bdf8] border border-[#38bdf8]/30">
                          {steps.length}
                        </span>
                      </span>
                      <button
                        onClick={() => {
                          const wf: Workflow = {
                            id: `WF_${Date.now().toString(36).toUpperCase()}`,
                            name: workflowName.trim() || 'Recorded Visual Workflow',
                            description: 'Recorded steps opened in builder',
                            ownerId: user?.uid || 'local_user',
                            version: 1,
                            schemaVersion: 2,
                            steps: [...steps],
                            variables: [],
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                          };
                          setBuilderWorkflow(wf);
                        }}
                        className="text-[#38bdf8] hover:text-[#7dd3fc] font-semibold text-[10px] transition-colors flex items-center gap-1"
                      >
                        Open in Canvas →
                      </button>
                    </div>

                    <ul className="space-y-1.5 max-h-[170px] overflow-y-auto pr-1 custom-scrollbar">
                      {steps.map((step, idx) => (
                        <li
                          key={step.id || idx}
                          className="text-xs p-2 bg-[#0E1326] rounded-lg border border-white/5 flex flex-col gap-0.5 hover:border-white/15 transition-colors"
                        >
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="font-extrabold text-[#F9DF9F] uppercase tracking-wider text-[9px] bg-[#1A2242] px-1.5 py-0.5 rounded border border-[#F9DF9F]/20">
                              {step.type}
                            </span>
                            <span className="text-[#CDE4E6]/50 font-mono">{(step.timestamp / 1000).toFixed(1)}s</span>
                          </div>
                          {step.target?.text && (
                            <span className="truncate text-[#CDE4E6] text-[10px] mt-0.5">
                              Target: <span className="text-amber-200/90 font-medium">"{step.target.text}"</span>
                            </span>
                          )}
                          {step.value && (
                            <span className="text-[#CDE4E6] truncate text-[10px]">
                              Value: <span className="text-cyan-200/90 font-mono">{step.value}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>

                    {!isRecording && (
                      <div className="pt-2 border-t border-white/5 flex flex-col space-y-2">
                        <input
                          type="text"
                          value={workflowName}
                          onChange={(e) => setWorkflowName(e.target.value)}
                          placeholder="Workflow Name (optional)"
                          className="w-full px-3 py-2 border border-white/10 rounded-lg text-xs bg-[#0E1326] text-[#CDE4E6] placeholder-[#CDE4E6]/40 outline-none focus:ring-1 focus:ring-[#F9DF9F] focus:border-[#F9DF9F]/50 transition-all"
                        />
                        <div className="flex space-x-2">
                          <button
                            onClick={saveWorkflow}
                            className="flex-1 bg-gradient-to-r from-[#F9DF9F] to-[#E9C376] hover:brightness-105 text-[#10152B] py-2 rounded-lg font-bold text-xs shadow-md transition-all active:scale-[0.98]"
                          >
                            Save Workflow
                          </button>
                          <button
                            onClick={() => {
                              setSteps([]);
                              setWorkflowName('');
                              if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                                chrome.runtime.sendMessage({ type: 'CLEAR_RECORDED_STEPS' });
                              }
                            }}
                            className="px-3.5 py-2 bg-[#0E1326] hover:bg-white/10 text-[#CDE4E6] rounded-lg font-semibold text-xs border border-white/10 transition-colors"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
