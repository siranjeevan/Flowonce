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
      chrome.runtime.sendMessage({ type: 'STOP_AND_SAVE_RECORDING' });
      recorder?.stop();
      removeRecordingIndicator();
      alert("✅ Recording stopped!\n\nPlease open the FlowOnce extension popup in the top right to save your workflow.");
    });
  }
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
