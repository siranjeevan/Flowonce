import { useState, useEffect } from 'react';
import type { WorkflowStep, Workflow } from '../../shared/types/workflow';
import { LocalStorageManager } from '../../workflow/storage/local-storage';
import { FirestoreStorageManager } from '../../workflow/storage/firestore-storage';
import { Auth } from './Auth';
import { WorkflowsList } from './WorkflowsList';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from '../../firebase/config';
import logoImg from '../../assets/image.png';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error'} | null>(null);
  const [activeTab, setActiveTab] = useState<'record' | 'workflows'>('record');
  const [workflowName, setWorkflowName] = useState('');

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

  useEffect(() => {
    // Initial state load
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
      if (response) {
        setIsRecording(response.isRecording);
        if (response.steps) setSteps(response.steps);
      }
    });

    const listener = (message: any) => {
      if (message.type === 'STEP_ADDED') {
        setSteps(prev => [...prev, message.payload]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!user) return;
    
    // Sync workflows saved locally from the content script modal up to the cloud
    const syncLocalWorkflows = async () => {
      try {
        const data = await chrome.storage.local.get(['workflows']);
        const localWorkflows = (data.workflows as Workflow[]) || [];
        
        if (localWorkflows.length > 0) {
          console.log(`Syncing ${localWorkflows.length} local workflows to cloud...`);
          for (const wf of localWorkflows) {
            // Ensure ownerId is set to the real user before uploading
            const cloudWf = { ...wf, ownerId: user.uid };
            await FirestoreStorageManager.saveWorkflow(cloudWf);
          }
          // Clear the local workflows array after successful sync
          await chrome.storage.local.set({ workflows: [] });
          showNotification(`Synced ${localWorkflows.length} offline workflow(s) to cloud!`, 'success');
          
          // If we are on the workflows tab, we should reload it. 
          // We can just trust the WorkflowsList component to fetch them since it mounts/updates.
        }
      } catch (err) {
        console.error("Failed to sync local workflows to cloud:", err);
      }
    };
    
    syncLocalWorkflows();
  }, [user]);

  const toggleRecording = async () => {
    const newState = !isRecording;
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // First try to send message to content script
    try {
      await chrome.tabs.sendMessage(tab.id, { 
        type: newState ? 'START_RECORDING' : 'STOP_RECORDING' 
      });
    } catch (e) {
      console.error("Could not send message to tab. Is the content script injected?", e);
      if (newState) {
        // If they tried to start recording, tell them to refresh
        showNotification('Cannot connect to this page. Please refresh the webpage and try again.', 'error');
        return;
      }
    }

    // Only update state if message succeeded (or if they are just trying to stop)
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
      schemaVersion: 1,
      steps: [...steps],
      variables: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    try {
      // Save locally as a backup
      await LocalStorageManager.saveWorkflow(workflow);
      
      // Save to Firestore
      if (user) {
        await FirestoreStorageManager.saveWorkflow(workflow);
        showNotification('Workflow saved to Cloud successfully!');
      } else {
        showNotification('Workflow saved locally (not logged in).');
      }
      setSteps([]);
      setWorkflowName('');
      chrome.runtime.sendMessage({ type: 'CLEAR_RECORDED_STEPS' });
      setActiveTab('workflows');
    } catch (e: any) {
      console.error('Failed to save workflow', e);
      showNotification(`Error: ${e.message || 'Unknown error'}`, 'error');
    }
  };

  return (
    <div className="w-[350px] min-h-[400px] bg-[#263056] text-[#CDE4E6] flex flex-col font-sans">
      <header className="p-4 border-b border-[#F9DF9F]/20 bg-[#263056] text-[#F9DF9F] shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={logoImg} alt="FlowOnce Logo" className="w-7 h-7 object-contain drop-shadow-md" style={{ mixBlendMode: 'screen' }} />
          <h1 className="text-xl font-bold tracking-tight">FlowOnce</h1>
        </div>
        {user && (
          <button 
            onClick={() => signOut(auth)}
            className="text-xs text-[#CDE4E6] hover:text-[#F9DF9F]"
          >
            Sign out
          </button>
        )}
      </header>
      
      {notification && (
        <div className={`p-2 text-center text-sm font-medium ${notification.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
          {notification.message}
        </div>
      )}

      <main className="flex-1 p-4 flex flex-col items-center justify-start space-y-6 overflow-y-auto">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">Loading...</div>
        ) : !user ? (
          <Auth onAuthSuccess={() => {}} />
        ) : (
          <>
            <div className="w-full flex space-x-1 p-1 bg-[#1A2240] rounded-lg mb-4">
              <button
                onClick={() => setActiveTab('record')}
                className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
                  activeTab === 'record'
                    ? 'bg-[#F9DF9F] shadow text-[#263056]'
                    : 'text-[#CDE4E6]/70 hover:text-[#CDE4E6] hover:bg-white/5'
                }`}
              >
                Record
              </button>
              <button
                onClick={() => setActiveTab('workflows')}
                className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
                  activeTab === 'workflows'
                    ? 'bg-[#F9DF9F] shadow text-[#263056]'
                    : 'text-[#CDE4E6]/70 hover:text-[#CDE4E6] hover:bg-white/5'
                }`}
              >
                My Workflows
              </button>
            </div>

            {activeTab === 'record' && (
              <div className="w-full flex flex-col space-y-4">
                <div className="text-center">
                  <p className="text-sm text-[#CDE4E6] font-medium">
                    Do it once. Share it. Run it again.
                  </p>
                  <p className="text-[10px] text-[#CDE4E6]/70 mt-1">Signed in as {user.email}</p>
                </div>

                <button 
                  onClick={toggleRecording}
                  className={`w-full py-3 rounded-md font-semibold shadow transition-colors flex items-center justify-center space-x-2 ${
                    isRecording ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056]'
                  }`}
                >
                  {isRecording ? (
                    <>
                      <span className="w-3 h-3 rounded-full bg-white animate-pulse"></span>
                      <span>Stop Recording</span>
                    </>
                  ) : (
                    <>
                      <span>+ Record Workflow</span>
                    </>
                  )}
                </button>

                {steps.length > 0 && (
                  <div className="w-full mt-4 flex flex-col space-y-3">
                    <h2 className="text-lg font-semibold border-b border-[#F9DF9F]/20 pb-2 text-[#F9DF9F]">
                      Recorded Steps ({steps.length})
                    </h2>
                    <ul className="space-y-2 max-h-[200px] overflow-y-auto">
                      {steps.map((step) => (
                        <li key={step.id} className="text-xs p-2 bg-[#1A2240] rounded border border-[#CDE4E6]/10 shadow-sm flex flex-col gap-1">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-[#F9DF9F] uppercase">{step.type}</span>
                            <span className="text-[#CDE4E6]/60">{(step.timestamp / 1000).toFixed(1)}s</span>
                          </div>
                          {step.target?.text && (
                            <span className="truncate text-[#CDE4E6]" title={step.target.text}>Target: "{step.target.text}"</span>
                          )}
                          {step.value && (
                            <span className="text-[#CDE4E6] truncate">Value: {step.value}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    
                    {!isRecording && (
                      <div className="pt-3 border-t border-[#F9DF9F]/20 flex flex-col space-y-3">
                        <input
                          type="text"
                          value={workflowName}
                          onChange={(e) => setWorkflowName(e.target.value)}
                          placeholder="Name your workflow (optional)"
                          className="w-full px-3 py-2 border border-[#CDE4E6]/20 rounded-md text-sm bg-[#1A2240] text-[#CDE4E6] placeholder-[#CDE4E6]/40 focus:outline-none focus:ring-2 focus:ring-[#F9DF9F] transition-shadow"
                        />
                        <div className="flex space-x-2">
                          <button 
                            onClick={saveWorkflow}
                            className="flex-1 bg-[#F9DF9F] hover:bg-[#e6cc8e] text-[#263056] py-2.5 rounded-md font-bold transition-colors shadow-sm"
                          >
                            Save Workflow
                          </button>
                          <button 
                            onClick={() => {
                              setSteps([]);
                              setWorkflowName('');
                              chrome.runtime.sendMessage({ type: 'CLEAR_RECORDED_STEPS' });
                            }} 
                            className="flex-none bg-[#1A2240] hover:bg-white/10 text-[#CDE4E6] px-4 py-2.5 rounded-md font-semibold transition-colors border border-[#CDE4E6]/20"
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

            {activeTab === 'workflows' && (
              <div className="w-full">
                <WorkflowsList user={user} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
