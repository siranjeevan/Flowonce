import { useState, useEffect } from 'react';
import type { WorkflowStep, Workflow } from '../../shared/types/workflow';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { FirestoreStorageManager } from '../../workflow/storage/firestore-storage';
import { LEGACY_STORAGE_KEYS } from '../../workflow/storage/storage-keys';
import { Auth } from './Auth';
import { WorkflowsList } from './WorkflowsList';
import { TemplatesView } from './TemplatesView';
import { SchedulesView } from './SchedulesView';
import { IntegrationsView } from './IntegrationsView';
import { ExecutionHistoryView } from './ExecutionHistoryView';
import { VisualWorkflowBuilder } from '../builder/VisualWorkflowBuilder';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from '../../firebase/config';
import logoImg from '../../assets/image.png';

type AppTab = 'record' | 'workflows' | 'templates' | 'schedules' | 'integrations' | 'history';

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
    <div className="w-[390px] min-h-[480px] max-h-[600px] bg-[#263056] text-[#CDE4E6] flex flex-col font-sans select-none">
      <header className="p-3.5 border-b border-[#F9DF9F]/20 bg-[#263056] text-[#F9DF9F] shadow-sm flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <img
            src={logoImg}
            alt="FlowOnce Logo"
            className="w-6 h-6 object-contain drop-shadow-md"
            style={{ mixBlendMode: 'screen' }}
          />
          <h1 className="text-lg font-bold tracking-tight">FlowOnce</h1>
          <span className="text-[10px] bg-[#1A2240] text-[#38bdf8] font-mono px-1.5 py-0.5 rounded font-bold border border-[#38bdf8]/30">
            PRO
          </span>
        </div>
        <div className="flex items-center gap-2">
          {user && (
            <button
              onClick={() => signOut(auth)}
              className="text-xs text-[#CDE4E6]/80 hover:text-[#F9DF9F]"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      {notification && (
        <div
          className={`p-2 text-center text-xs font-semibold ${
            notification.type === 'success'
              ? 'bg-emerald-950 text-emerald-300 border-b border-emerald-500/30'
              : 'bg-red-950 text-red-300 border-b border-red-500/30'
          }`}
        >
          {notification.message}
        </div>
      )}

      <main className="flex-1 p-3 flex flex-col items-center justify-start overflow-y-auto">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-xs">Loading...</div>
        ) : !user && !isLocalMode ? (
          <Auth onAuthSuccess={() => setIsLocalMode(true)} />
        ) : (
          <>
            {/* Global Tab Navigation Bar */}
            <div className="w-full grid grid-cols-6 gap-1 p-1 bg-[#1A2240] rounded-lg mb-3 text-[10px] font-semibold text-center">
              {[
                { id: 'workflows', label: 'Workflows' },
                { id: 'record', label: 'Record' },
                { id: 'templates', label: 'Templates' },
                { id: 'schedules', label: 'Schedules' },
                { id: 'integrations', label: 'APIs' },
                { id: 'history', label: 'History' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as AppTab)}
                  className={`py-1.5 rounded transition-all truncate ${
                    activeTab === tab.id
                      ? 'bg-[#F9DF9F] shadow text-[#263056] font-bold'
                      : 'text-[#CDE4E6]/70 hover:text-[#CDE4E6] hover:bg-white/5'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* TAB: WORKFLOWS */}
            {activeTab === 'workflows' && (
              <div className="w-full flex flex-col space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#CDE4E6]/60">Visual Builder & Replays</span>
                  <button
                    onClick={createBlankWorkflow}
                    className="px-2.5 py-1 rounded bg-[#F9DF9F] text-[#263056] text-xs font-bold hover:bg-[#e6cc8e] shadow-sm flex items-center gap-1"
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
                <div className="text-center">
                  <p className="text-xs text-[#CDE4E6] font-medium">
                    Do it once. Share it. Run it again.
                  </p>
                  <p className="text-[10px] text-[#CDE4E6]/60 mt-0.5">
                    {user?.email ? `Signed in as ${user.email}` : 'Local Workspace Mode'}
                  </p>
                </div>

                <button
                  onClick={toggleRecording}
                  className={`w-full py-2.5 rounded-lg font-bold text-xs shadow transition-colors flex items-center justify-center space-x-2 ${
                    isRecording
                      ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
                      : 'bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056]'
                  }`}
                >
                  {isRecording ? (
                    <>
                      <span className="w-2.5 h-2.5 rounded-full bg-white"></span>
                      <span>Stop Recording</span>
                    </>
                  ) : (
                    <>
                      <span>● Start Recording Interactions</span>
                    </>
                  )}
                </button>

                {steps.length > 0 && (
                  <div className="w-full mt-2 flex flex-col space-y-2">
                    <h2 className="text-xs font-bold border-b border-[#F9DF9F]/20 pb-1.5 text-[#F9DF9F] flex justify-between">
                      <span>Recorded Steps ({steps.length})</span>
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
                        className="text-[#38bdf8] hover:underline font-normal text-[10px]"
                      >
                        Open in Canvas →
                      </button>
                    </h2>

                    <ul className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                      {steps.map((step, idx) => (
                        <li
                          key={step.id || idx}
                          className="text-xs p-2 bg-[#1A2240] rounded border border-[#CDE4E6]/10 flex flex-col gap-0.5"
                        >
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="font-bold text-[#F9DF9F] uppercase">{step.type}</span>
                            <span className="text-[#CDE4E6]/50">{(step.timestamp / 1000).toFixed(1)}s</span>
                          </div>
                          {step.target?.text && (
                            <span className="truncate text-[#CDE4E6] text-[10px]">Target: "{step.target.text}"</span>
                          )}
                          {step.value && (
                            <span className="text-[#CDE4E6] truncate text-[10px]">Value: {step.value}</span>
                          )}
                        </li>
                      ))}
                    </ul>

                    {!isRecording && (
                      <div className="pt-2 border-t border-[#F9DF9F]/20 flex flex-col space-y-2">
                        <input
                          type="text"
                          value={workflowName}
                          onChange={(e) => setWorkflowName(e.target.value)}
                          placeholder="Workflow Name (optional)"
                          className="w-full px-2.5 py-1.5 border border-[#CDE4E6]/20 rounded text-xs bg-[#1A2240] text-[#CDE4E6] outline-none focus:ring-1 focus:ring-[#F9DF9F]"
                        />
                        <div className="flex space-x-2">
                          <button
                            onClick={saveWorkflow}
                            className="flex-1 bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056] py-2 rounded font-bold text-xs shadow-sm"
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
                            className="px-3 py-2 bg-[#1A2240] hover:bg-white/10 text-[#CDE4E6] rounded font-semibold text-xs border border-[#CDE4E6]/20"
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

            {/* TAB: TEMPLATES */}
            {activeTab === 'templates' && (
              <TemplatesView
                userId={user?.uid || 'local_user'}
                onWorkflowCreated={(newWf) => {
                  setBuilderWorkflow(newWf);
                  showNotification(`Created workflow from template: ${newWf.name}`);
                }}
              />
            )}

            {/* TAB: SCHEDULES */}
            {activeTab === 'schedules' && <SchedulesView />}

            {/* TAB: INTEGRATIONS */}
            {activeTab === 'integrations' && <IntegrationsView />}

            {/* TAB: HISTORY */}
            {activeTab === 'history' && <ExecutionHistoryView />}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
