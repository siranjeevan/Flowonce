import { Recorder } from '../../recorder/event-capture';
import type { WorkflowStep } from '../../shared/types/workflow';

console.log("FlowOnce Content Script injected.");

let recorder: Recorder | null = null;
let indicatorEl: HTMLDivElement | null = null;

function showRecordingIndicator() {
  if (indicatorEl) return;
  indicatorEl = document.createElement('div');
  indicatorEl.id = 'flowonce-recording-indicator';
  indicatorEl.innerHTML = `
    <div style="display: flex; align-items: center; gap: 16px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 12px; height: 12px; background-color: #ff4d4f; border-radius: 50%; box-shadow: 0 0 8px #ff4d4f; animation: flowonce-pulse 1.5s infinite;"></div>
        <span style="font-family: 'Inter', system-ui, sans-serif; font-size: 14px; font-weight: 600; color: #F9DF9F; letter-spacing: 0.5px;">FlowOnce Recording...</span>
      </div>
      <button id="flowonce-stop-btn" style="background: rgba(255, 77, 79, 0.15); border: 1px solid rgba(255, 77, 79, 0.5); color: #ff4d4f; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: 'Inter', system-ui, sans-serif; transition: all 0.2s;">
        <span style="font-size: 12px;">⏹</span> Stop & Save
      </button>
    </div>
  `;
  
  // Styling
  Object.assign(indicatorEl.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: '#263056',
    padding: '12px 24px',
    borderRadius: '30px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    zIndex: '2147483647', // Max z-index to stay on top
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    border: '1px solid rgba(249, 223, 159, 0.2)',
    transition: 'all 0.3s ease'
  });

  // Pulse animation style
  const style = document.createElement('style');
  style.id = 'flowonce-recording-style';
  style.textContent = `
    @keyframes flowonce-pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(255, 77, 79, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(255, 77, 79, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(255, 77, 79, 0); }
    }
  `;
  
  document.head.appendChild(style);
  document.body.appendChild(indicatorEl);

  const stopBtn = indicatorEl.querySelector('#flowonce-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('mouseover', () => {
      (stopBtn as HTMLElement).style.background = 'rgba(255, 77, 79, 0.25)';
    });
    stopBtn.addEventListener('mouseout', () => {
      (stopBtn as HTMLElement).style.background = 'rgba(255, 77, 79, 0.15)';
    });
    stopBtn.addEventListener('click', () => {
      recorder?.stop();
      removeRecordingIndicator();
      showSaveModal();
    });
  }
}

function showSaveModal() {
  const modalEl = document.createElement('div');
  modalEl.id = 'flowonce-save-modal';
  
  // Overlay background
  Object.assign(modalEl.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '2147483647', fontFamily: "'Inter', system-ui, sans-serif"
  });

  const modalContent = document.createElement('div');
  Object.assign(modalContent.style, {
    backgroundColor: '#263056', padding: '32px', borderRadius: '16px',
    width: '400px', maxWidth: '90%', boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
    border: '1px solid rgba(249, 223, 159, 0.2)', display: 'flex', flexDirection: 'column', gap: '16px'
  });

  modalContent.innerHTML = `
    <h2 style="margin: 0; color: #F9DF9F; font-size: 20px; font-weight: 700;">Save Workflow</h2>
    <p style="margin: 0; color: #CDE4E6; opacity: 0.8; font-size: 14px;">Give your new automation a name.</p>
    <input type="text" id="flowonce-workflow-name" placeholder="E.g., Meesho Order Placement" style="
      background: #1A2240; border: 1px solid rgba(205, 228, 230, 0.2); border-radius: 8px;
      padding: 12px 16px; color: #CDE4E6; font-size: 14px; outline: none; margin-top: 8px; width: 100%; box-sizing: border-box;
    ">
    <div style="display: flex; gap: 12px; margin-top: 16px;">
      <button id="flowonce-cancel-btn" style="flex: 1; padding: 12px; border-radius: 8px; background: transparent; border: 1px solid rgba(205, 228, 230, 0.2); color: #CDE4E6; cursor: pointer; font-weight: 600;">Discard</button>
      <button id="flowonce-save-btn" style="flex: 2; padding: 12px; border-radius: 8px; background: #F9DF9F; border: none; color: #263056; cursor: pointer; font-weight: 700; box-shadow: 0 4px 12px rgba(249, 223, 159, 0.2);">Save Workflow</button>
    </div>
  `;

  modalEl.appendChild(modalContent);
  document.body.appendChild(modalEl);

  const inputEl = document.getElementById('flowonce-workflow-name') as HTMLInputElement;
  inputEl?.focus();

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('flowonce-save-btn')?.click();
    }
  });

  document.getElementById('flowonce-cancel-btn')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AND_SAVE_RECORDING' }); // Just stop it without saving
    document.body.removeChild(modalEl);
  });

  document.getElementById('flowonce-save-btn')?.addEventListener('click', () => {
    const name = inputEl?.value.trim() || undefined;
    
    // Animate save button
    const saveBtn = document.getElementById('flowonce-save-btn');
    if (saveBtn) {
      saveBtn.innerText = 'Saving...';
      saveBtn.style.opacity = '0.8';
      saveBtn.style.pointerEvents = 'none';
    }

    chrome.runtime.sendMessage({ 
      type: 'SAVE_WORKFLOW_FROM_CONTENT',
      payload: { name }
    }, (response) => {
      if (chrome.runtime.lastError) {
         console.error(chrome.runtime.lastError);
         alert("❌ Extension connection error. Please refresh the page and try again.");
         if (modalEl.parentNode) document.body.removeChild(modalEl);
         return;
      }
      if (modalEl.parentNode) document.body.removeChild(modalEl);
      if (response && response.success) {
        alert("✅ Workflow Saved Successfully!\n\nYou can view and run it from the FlowOnce extension popup.");
      } else {
        alert("❌ Failed to save workflow: " + (response?.error || 'Unknown error'));
      }
    });
  });
}

function removeRecordingIndicator() {
  if (indicatorEl && indicatorEl.parentNode) {
    indicatorEl.parentNode.removeChild(indicatorEl);
    indicatorEl = null;
  }
  const style = document.getElementById('flowonce-recording-style');
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
}

// Initialize recorder and handle messages from background/popup
function initializeRecorder() {
  if (!recorder) {
    recorder = new Recorder((step: WorkflowStep) => {
      console.log("Recorded step:", step);
      // Send the step to the background script for storage
      chrome.runtime.sendMessage({
        type: 'RECORDED_STEP',
        payload: step
      });
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    initializeRecorder();
    recorder?.start();
    showRecordingIndicator();
    sendResponse({ success: true });
  } else if (message.type === 'STOP_RECORDING') {
    recorder?.stop();
    removeRecordingIndicator();
    sendResponse({ success: true });
  } else if (message.type === 'EXECUTE_STEP') {
    import('../../replay/ActionExecutor').then(({ ActionExecutor }) => {
      ActionExecutor.execute(message.payload.step, message.payload.speedMultiplier)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
    });
    return true; // Keep message channel open for async response
  }
});

// Check if recording is already active (e.g. after a page navigation)
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
  if (response && response.isRecording) {
    console.log("FlowOnce: Resuming recording after navigation");
    initializeRecorder();
    recorder?.start();
    showRecordingIndicator();
  }
});
