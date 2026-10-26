import { Recorder } from '../../recorder/event-capture';
import type { WorkflowStep } from '../../shared/types/workflow';
import { ActionExecutor } from '../../replay/ActionExecutor';
import { ActionVerifier, classifyActionSafety } from '../../replay/ActionVerifier';
import { TargetResolver } from '../../replay/TargetResolver';

console.log("FlowOnce Content Script injected.");

let recorder: Recorder | null = null;
let indicatorEl: HTMLDivElement | null = null;
let replayIndicatorEl: HTMLDivElement | null = null;

function showRecordingIndicator() {
  if (indicatorEl) return;
  indicatorEl = document.createElement('div');
  indicatorEl.id = 'flowonce-recording-indicator';
  indicatorEl.innerHTML = `
    <div style="display: flex; align-items: center; gap: 16px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 12px; height: 12px; background-color: #ff4d4f; border-radius: 50%; box-shadow: 0 0 8px #ff4d4f; animation: flowonce-pulse 1.5s infinite;"></div>
        <span id="flowonce-recording-text" style="font-family: 'Inter', system-ui, sans-serif; font-size: 14px; font-weight: 600; color: #F9DF9F; letter-spacing: 0.5px; transition: all 0.3s ease;">FlowOnce Recording...</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button id="flowonce-pause-record-btn" style="background: transparent; border: 1px solid rgba(249, 223, 159, 0.4); color: #F9DF9F; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: 'Inter', system-ui, sans-serif; transition: all 0.2s;">
          <span style="font-size: 12px;">⏸</span> Pause
        </button>
        <button id="flowonce-stop-btn" style="background: rgba(255, 77, 79, 0.15); border: 1px solid rgba(255, 77, 79, 0.5); color: #ff4d4f; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: 'Inter', system-ui, sans-serif; transition: all 0.2s;">
          <span style="font-size: 12px;">⏹</span> Stop & Save
        </button>
      </div>
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

  const pauseBtn = indicatorEl.querySelector('#flowonce-pause-record-btn');
  let isRecordingPaused = false;
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      isRecordingPaused = !isRecordingPaused;
      if (isRecordingPaused) {
        recorder?.pause();
        pauseBtn.innerHTML = '<span style="font-size: 12px;">▶️</span> Resume';
        const txt = document.getElementById('flowonce-recording-text');
        if(txt) txt.innerText = 'Recording Paused';
      } else {
        recorder?.resume();
        pauseBtn.innerHTML = '<span style="font-size: 12px;">⏸</span> Pause';
        const txt = document.getElementById('flowonce-recording-text');
        if(txt) txt.innerText = 'FlowOnce Recording...';
      }
    });
  }

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
    if (modalEl.parentNode) document.body.removeChild(modalEl);
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
      if (modalEl.parentNode) document.body.removeChild(modalEl);

      if (chrome.runtime.lastError) {
         console.error(chrome.runtime.lastError);
         showFlowOnceToast("Extension Connection Error", "Please refresh the page and try again.", false);
         return;
      }
      if (response && response.success) {
        showFlowOnceToast("Workflow Saved Successfully!", "You can view and run it from the FlowOnce extension popup.", true);
      } else {
        showFlowOnceToast("Failed to Save Workflow", response?.error || 'Unknown error occurred.', false);
      }
    });
  });
}

function showFlowOnceToast(title: string, subtitle?: string, isSuccess = true) {
  const existing = document.getElementById('flowonce-toast');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  const toast = document.createElement('div');
  toast.id = 'flowonce-toast';
  Object.assign(toast.style, {
    position: 'fixed',
    top: '28px',
    left: '50%',
    transform: 'translateX(-50%) translateY(-20px)',
    backgroundColor: '#263056',
    border: isSuccess ? '1px solid rgba(249, 223, 159, 0.4)' : '1px solid rgba(255, 77, 79, 0.4)',
    borderRadius: '14px',
    padding: '14px 22px',
    boxShadow: '0 16px 40px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.1)',
    zIndex: '2147483647',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    color: '#CDE4E6',
    maxWidth: '460px',
    opacity: '0',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    pointerEvents: 'auto'
  });

  const icon = isSuccess ? '✅' : '❌';
  toast.innerHTML = `
    <span style="font-size: 20px; line-height: 1;">${icon}</span>
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <span style="color: ${isSuccess ? '#F9DF9F' : '#ff7875'}; font-size: 14px; font-weight: 700; line-height: 1.3;">${title}</span>
      ${subtitle ? `<span style="color: #CDE4E6; opacity: 0.85; font-size: 12px; line-height: 1.4;">${subtitle}</span>` : ''}
    </div>
    <button id="flowonce-toast-close" style="
      background: transparent; border: none; color: #CDE4E6; opacity: 0.6;
      cursor: pointer; font-size: 16px; line-height: 1; padding: 4px; margin-left: 8px;
    ">✕</button>
  `;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  const closeToast = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  };

  toast.querySelector('#flowonce-toast-close')?.addEventListener('click', closeToast);

  setTimeout(closeToast, 4000);
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

function showCaptureFeedback(actionType: string) {
  const textEl = document.getElementById('flowonce-recording-text');
  if (!textEl) return;
  
  const actionName = actionType.charAt(0).toUpperCase() + actionType.slice(1);
  textEl.innerText = `✅ ${actionName} Captured!`;
  textEl.style.color = '#52c41a'; // success green color
  
  // Revert back after 1.2 seconds
  setTimeout(() => {
    // Only revert if it hasn't been overwritten by another capture
    if (textEl.innerText.includes('Captured')) {
      textEl.innerText = 'FlowOnce Recording...';
      textEl.style.color = '#F9DF9F';
    }
  }, 1200);
}

function showReplayIndicator(
  stepIndex: number,
  totalSteps: number,
  stepType: string,
  stepValue: string,
  datasetInfo?: { recordIndex: number; totalRecords: number }
) {
  if (!replayIndicatorEl) {
    replayIndicatorEl = document.createElement('div');
    replayIndicatorEl.id = 'flowonce-replay-indicator';
    document.body.appendChild(replayIndicatorEl);
    
    Object.assign(replayIndicatorEl.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: '#263056',
      padding: '12px 24px',
      borderRadius: '30px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      pointerEvents: 'auto', // Allow clicking pause button
      border: '1px solid rgba(249, 223, 159, 0.2)',
      transition: 'all 0.3s ease',
      fontFamily: "'Inter', system-ui, sans-serif",
      color: '#CDE4E6'
    });
  } else {
    // Reset border in case it was previously an error
    replayIndicatorEl.style.border = '1px solid rgba(249, 223, 159, 0.2)';
    replayIndicatorEl.style.pointerEvents = 'auto';
  }

  const prefix = datasetInfo
    ? `Record ${datasetInfo.recordIndex}/${datasetInfo.totalRecords} • Step ${stepIndex}/${totalSteps}`
    : `Running Step ${stepIndex}/${totalSteps}`;
  
  replayIndicatorEl.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <svg class="flowonce-spin" style="width: 16px; height: 16px; color: #F9DF9F;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle style="opacity: 0.25;" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path style="opacity: 0.75;" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span style="font-size: 14px; font-weight: 600; color: #F9DF9F; letter-spacing: 0.5px;">${prefix}</span>
      <span id="flowonce-step-status" style="font-size: 12px; font-weight: 500; opacity: 0.9; background: #1A2240; padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(205, 228, 230, 0.15); max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
        <span style="color: #CDE4E6; font-weight: 700; margin-right: 4px;">${stepType.toUpperCase()}</span> ${stepValue}
      </span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px; margin-left: 12px;">
      <button id="flowonce-pause-replay-btn" style="background: transparent; border: 1px solid rgba(249, 223, 159, 0.4); color: #F9DF9F; border-radius: 6px; padding: 4px 8px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s;">
        ⏸ Pause
      </button>
      <button id="flowonce-stop-replay-btn" style="background: rgba(255, 77, 79, 0.15); border: 1px solid rgba(255, 77, 79, 0.4); color: #ff4d4f; border-radius: 6px; padding: 4px 8px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s;">
        ⏹ Stop
      </button>
    </div>
  `;
  
  // Attach event listener for Pause/Resume Replay
  // We need to wait for it to be added to DOM, but since innerHTML replaces it, we can just query it from replayIndicatorEl
  const pauseReplayBtn = replayIndicatorEl.querySelector('#flowonce-pause-replay-btn');
  if (pauseReplayBtn) {
    if (replayIndicatorEl.dataset.isPaused === 'true') {
      pauseReplayBtn.innerHTML = '▶️ Resume';
      const statusEl = replayIndicatorEl.querySelector('#flowonce-step-status');
      if(statusEl) statusEl.innerHTML = '(Paused)';
    }

    pauseReplayBtn.addEventListener('click', () => {
      const currentlyPaused = replayIndicatorEl!.dataset.isPaused === 'true';
      if (currentlyPaused) {
        replayIndicatorEl!.dataset.isPaused = 'false';
        pauseReplayBtn.innerHTML = '⏸ Pause';
        chrome.runtime.sendMessage({ type: 'RESUME_WORKFLOW' });
      } else {
        replayIndicatorEl!.dataset.isPaused = 'true';
        pauseReplayBtn.innerHTML = '▶️ Resume';
        const statusEl = replayIndicatorEl!.querySelector('#flowonce-step-status');
        if(statusEl) statusEl.innerHTML = '(Paused)';
        chrome.runtime.sendMessage({ type: 'PAUSE_WORKFLOW' });
      }
    });
  }

  const stopReplayBtn = replayIndicatorEl.querySelector('#flowonce-stop-replay-btn');
  if (stopReplayBtn) {
    stopReplayBtn.addEventListener('click', () => {
      hideReplayIndicator();
      chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW' });
    });
  }
  
  if (!document.getElementById('flowonce-spin-style')) {
    const style = document.createElement('style');
    style.id = 'flowonce-spin-style';
    style.textContent = `
      @keyframes flowonce-spin { to { transform: rotate(360deg); } }
      .flowonce-spin { animation: flowonce-spin 1s linear infinite; }
    `;
    document.head.appendChild(style);
  }
}

function hideReplayIndicator() {
  if (replayIndicatorEl && replayIndicatorEl.parentNode) {
    replayIndicatorEl.parentNode.removeChild(replayIndicatorEl);
    replayIndicatorEl = null;
  }
}

function showReplayError(errorMessage: string) {
  if (!replayIndicatorEl) {
    // Re-create it if it doesn't exist, though it usually should
    showReplayIndicator(0, 0, 'Error', 'Failed');
  }
  
  if (replayIndicatorEl) {
    replayIndicatorEl.style.border = '1px solid rgba(255, 77, 79, 0.6)';
    replayIndicatorEl.style.pointerEvents = 'auto'; // allow interaction for copying
    replayIndicatorEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; background-color: #ff4d4f; color: white; border-radius: 50%; font-size: 11px; font-weight: bold; font-family: sans-serif;">!</div>
        <span style="font-size: 14px; font-weight: 600; color: #ff4d4f; letter-spacing: 0.5px;">Replay Failed</span>
        <span style="user-select: text; cursor: text; font-size: 12px; font-weight: 500; opacity: 0.95; background: rgba(255, 77, 79, 0.12); padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(255, 77, 79, 0.3); max-width: 450px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ff6b6b;" title="${errorMessage.replace(/"/g, '&quot;')}">
          ${errorMessage}
        </span>
        <button id="flowonce-copy-error-btn" style="background: rgba(255, 77, 79, 0.15); border: 1px solid rgba(255,77,79,0.4); color: #ff4d4f; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s;">Copy</button>
        <button id="flowonce-close-error-btn" style="background: transparent; border: none; color: rgba(255,255,255,0.6); font-size: 14px; cursor: pointer; padding: 2px 6px; line-height: 1;">✕</button>
      </div>
    `;

    const copyBtn = document.getElementById('flowonce-copy-error-btn');
    if (copyBtn) {
      copyBtn.addEventListener('mouseover', () => copyBtn.style.background = 'rgba(255, 77, 79, 0.25)');
      copyBtn.addEventListener('mouseout', () => copyBtn.style.background = 'rgba(255, 77, 79, 0.15)');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(errorMessage).then(() => {
          copyBtn.innerText = 'Copied!';
          setTimeout(() => { if (copyBtn) copyBtn.innerText = 'Copy'; }, 2000);
        });
      });
    }

    const closeBtn = document.getElementById('flowonce-close-error-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => hideReplayIndicator());
    }

    // Auto-hide after 30 seconds to give plenty of time to view or copy
    setTimeout(() => hideReplayIndicator(), 30000);
  }
}

function showRecoveryHUD(session?: any, step?: WorkflowStep, message?: string) {
  if (!replayIndicatorEl) {
    showReplayIndicator(0, 0, 'Recovery', 'Required');
  }

  if (replayIndicatorEl) {
    replayIndicatorEl.style.border = '1px solid rgba(250, 173, 20, 0.8)';
    replayIndicatorEl.style.maxWidth = '560px';
    replayIndicatorEl.style.width = 'auto';
    replayIndicatorEl.style.pointerEvents = 'auto';

    const stepIndex = session ? session.currentStepIndex + 1 : (step?.sequence ?? 1);
    const actionType = step?.type?.toUpperCase() || 'ACTION';
    const safety = step ? classifyActionSafety(step) : 'EXTERNAL_SIDE_EFFECT';
    const isUnsafe = safety === 'EXTERNAL_SIDE_EFFECT' || safety === 'TOGGLE_STATE';
    const stepDetail = step?.sensitive
      ? '••••••••'
      : (step?.value || step?.key || (step?.target?.text ? `"${step.target.text}"` : step?.target?.selector) || '');
    const reasonText = message || session?.lastError || 'Action outcome could not be verified automatically.';

    const datasetBadge = session?.datasetState
      ? `<span style="background: rgba(250, 173, 20, 0.2); color: #ffe58f; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 6px;">Record ${session.datasetState.currentRecordIndex + 1}/${session.datasetState.totalRecords}</span>`
      : '';

    const safetyBadge = isUnsafe
      ? `<span style="background: rgba(255, 77, 79, 0.2); color: #ff7875; border: 1px solid rgba(255, 77, 79, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;">SIDE EFFECT</span>`
      : `<span style="background: rgba(82, 196, 26, 0.2); color: #95de64; border: 1px solid rgba(82, 196, 26, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;">IDEMPOTENT</span>`;

    replayIndicatorEl.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 15px;">⚠️</span>
            <span style="font-size: 13px; font-weight: 700; color: #faad14;">Recovery Required • Step ${stepIndex}</span>
            ${datasetBadge}
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${safetyBadge}
            <button id="flowonce-close-uncertain-btn" style="background: transparent; border: none; color: rgba(255,255,255,0.6); font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1;">✕</button>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;">
          <span style="color: #F9DF9F; font-weight: 600;">${actionType}</span>
          <span style="color: #CDE4E6; opacity: 0.9; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${stepDetail}</span>
        </div>

        <div id="flowonce-recovery-reason" style="font-size: 11px; color: #ffe58f; background: rgba(250, 173, 20, 0.1); padding: 5px 8px; border-radius: 4px; border: 1px solid rgba(250, 173, 20, 0.2); line-height: 1.4;">
          ${reasonText}
        </div>

        ${isUnsafe ? `
          <div style="font-size: 10px; color: #ff7875; display: flex; align-items: center; gap: 4px;">
            <span>⚠️</span> Repeating this action may trigger duplicate external side effects.
          </div>
        ` : ''}

        <div id="flowonce-inspection-result" style="display: none; font-size: 11px; background: rgba(26, 34, 64, 0.9); padding: 6px 8px; border-radius: 4px; border: 1px solid rgba(205, 228, 230, 0.2); color: #CDE4E6;"></div>

        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px;">
          <button id="flowonce-inspect-page-btn" style="background: rgba(205, 228, 230, 0.15); border: 1px solid rgba(205, 228, 230, 0.3); color: #CDE4E6; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer;">
            🔍 Inspect Page
          </button>
          <button id="flowonce-recheck-condition-btn" style="background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.4); color: #a5b4fc; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer;">
            🔄 Recheck
          </button>
          <button id="flowonce-resume-advance-btn" style="background: rgba(82, 196, 26, 0.2); border: 1px solid rgba(82, 196, 26, 0.5); color: #95de64; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">
            ✅ Confirm Success
          </button>
          <button id="flowonce-retry-action-btn" style="background: rgba(250, 173, 20, 0.2); border: 1px solid rgba(250, 173, 20, 0.5); color: #faad14; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer;">
            🔁 Retry
          </button>
          <button id="flowonce-stop-uncertain-btn" style="background: rgba(255, 77, 79, 0.15); border: 1px solid rgba(255, 77, 79, 0.4); color: #ff4d4f; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer; margin-left: auto;">
            ⏹ Stop
          </button>
        </div>
      </div>
    `;

    const inspectBtn = document.getElementById('flowonce-inspect-page-btn');
    if (inspectBtn) {
      inspectBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'RECOVERY_INSPECT_PAGE' }, (resp) => {
          const resEl = document.getElementById('flowonce-inspection-result');
          if (resEl && resp && resp.inspection) {
            resEl.style.display = 'block';
            resEl.innerHTML = `<strong>Page:</strong> ${resp.inspection.url || 'unknown'}<br/><strong>Target in DOM:</strong> ${resp.inspection.targetFound ? '✅ Yes' : '❌ No'}`;
          }
        });
      });
    }

    const recheckBtn = document.getElementById('flowonce-recheck-condition-btn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', () => {
        recheckBtn.innerText = 'Checking...';
        chrome.runtime.sendMessage({ type: 'RECOVERY_RECHECK_CONDITION' }, (resp) => {
          recheckBtn.innerText = '🔄 Recheck';
          const reasonEl = document.getElementById('flowonce-recovery-reason');
          if (reasonEl && resp) {
            if (resp.verification?.status === 'VERIFIED') {
              reasonEl.style.borderColor = 'rgba(82, 196, 26, 0.6)';
              reasonEl.style.color = '#95de64';
              reasonEl.innerHTML = '✅ Postcondition verified! Click <strong>Confirm Success</strong> to continue.';
            } else {
              reasonEl.innerHTML = `Recheck: ${resp.verification?.status || 'Inconclusive'}. Still uncertain.`;
            }
          }
        });
      });
    }

    const advanceBtn = document.getElementById('flowonce-resume-advance-btn');
    if (advanceBtn) {
      advanceBtn.addEventListener('click', () => {
        hideReplayIndicator();
        chrome.runtime.sendMessage({
          type: 'RECOVERY_CONFIRM_SUCCESS',
          payload: { forceAdvance: true },
        });
      });
    }

    const retryBtn = document.getElementById('flowonce-retry-action-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (isUnsafe) {
          const proceed = window.confirm(
            '⚠️ WARNING: This action has external side effects (e.g. submit/click). Retrying may create duplicate actions. Are you sure you want to proceed?'
          );
          if (!proceed) return;
        }
        hideReplayIndicator();
        chrome.runtime.sendMessage({
          type: 'RECOVERY_CONFIRM_FAILURE_RETRY',
          payload: { forceUnsafeRetry: true },
        });
      });
    }

    const stopBtn = document.getElementById('flowonce-stop-uncertain-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        hideReplayIndicator();
        chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW' });
      });
    }

    const closeBtn = document.getElementById('flowonce-close-uncertain-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => hideReplayIndicator());
    }
  }
}

function showReplayUncertain(message: string) {
  showRecoveryHUD(undefined, undefined, message);
}

// Initialize recorder and handle messages from background/popup
function initializeRecorder() {
  if (!recorder) {
    recorder = new Recorder((step: WorkflowStep) => {
      console.log("Recorded step:", step);
      
      // Show visual feedback on the bottom indicator
      showCaptureFeedback(step.type);

      // Send the step to the background script for storage
      chrome.runtime.sendMessage({
        type: 'RECORDED_STEP',
        payload: step
      });
    });
  }
}

let activeStepAbortController: AbortController | null = null;
const executedActionIds = new Set<string>();

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
  } else if (message.type === 'CHECK_ACTION_EXECUTED') {
    const actionId = message.payload?.actionId;
    const executed = actionId ? executedActionIds.has(actionId) : false;
    sendResponse({ success: true, executed });
    return false;
  } else if (message.type === 'EXECUTE_STEP') {
    // Cancel previous step wait if still active
    if (activeStepAbortController) {
      activeStepAbortController.abort();
    }
    activeStepAbortController = new AbortController();

    const { step, speedMultiplier, index, total, sessionId, actionId, datasetInfo } = message.payload;

    // Idempotency check: prevent duplicate execution of already-executed action
    if (actionId && executedActionIds.has(actionId)) {
      console.log(`[Content] Action ${actionId} was already executed. Returning cached success.`);
      sendResponse({ success: true, alreadyExecuted: true, actionId });
      return false;
    }
    
    // Extract a descriptive detail for the step
    const stepDetail = step.sensitive ? '••••••••' : (step.value || step.key || (step.target?.text ? `"${step.target.text}"` : step.target?.selector) || '');
    if (index && total) {
      showReplayIndicator(index, total, step.type, stepDetail, datasetInfo);
    }
    
    ActionExecutor.executeWithVerification(step, speedMultiplier, {
      signal: activeStepAbortController.signal,
      sessionId,
      stepIndex: index,
      actionId,
    })
      .then((execResult) => {
        if (actionId && execResult.success) {
          executedActionIds.add(actionId);
          if (executedActionIds.size > 100) {
            const first = executedActionIds.values().next().value;
            if (first) executedActionIds.delete(first);
          }
        }
        activeStepAbortController = null;
        if (execResult.success) {
          try {
            sendResponse({
              success: true,
              actionId,
              verification: execResult.verification,
              extractedValue: execResult.extractedValue,
              navigationTriggered: execResult.navigationTriggered,
              navigatedTo: execResult.navigatedTo,
            });
          } catch {}
        } else {
          if (execResult.verification?.status === 'OUTCOME_UNKNOWN') {
            showReplayUncertain(
              execResult.verification.recoveryRecommendation ||
                'Action dispatched, but outcome could not be confirmed. Replay paused.'
            );
          } else {
            const errorMsg = execResult.error || 'Action verification failed';
            showReplayError(errorMsg);
          }
          try {
            sendResponse({
              success: false,
              actionId,
              verification: execResult.verification,
              error: execResult.error,
              code: execResult.code,
            });
          } catch {}
        }
      })
      .catch((err) => {
        activeStepAbortController = null;
        const errorMsg = err?.message || 'Execution failed';
        showReplayError(errorMsg);
        try {
          sendResponse({ success: false, error: errorMsg, code: err?.code });
        } catch {}
      });
    return true; // Keep message channel open for async response
  } else if (message.type === 'HIDE_REPLAY_INDICATOR') {
    if (activeStepAbortController) {
      activeStepAbortController.abort();
      activeStepAbortController = null;
    }
    hideReplayIndicator();
    sendResponse({ success: true });
  } else if (message.type === 'SHOW_REPLAY_ERROR') {
    if (activeStepAbortController) {
      activeStepAbortController.abort();
      activeStepAbortController = null;
    }
    showReplayError(message.payload?.error || 'Execution failed');
    sendResponse({ success: true });
  } else if (message.type === 'SHOW_REPLAY_UNCERTAIN') {
    if (activeStepAbortController) {
      activeStepAbortController.abort();
      activeStepAbortController = null;
    }
    showReplayUncertain(message.payload?.message || 'Outcome uncertain');
    sendResponse({ success: true });
  } else if (message.type === 'SHOW_RECOVERY_HUD') {
    if (activeStepAbortController) {
      activeStepAbortController.abort();
      activeStepAbortController = null;
    }
    showRecoveryHUD(message.payload?.session, message.payload?.step, message.payload?.message);
    sendResponse({ success: true });
  } else if (message.type === 'RECHECK_STEP_CONDITION') {
    const { step, sessionId, actionId, stepIndex } = message.payload || {};
    ActionVerifier.verifyAction(step, null, {
      sessionId,
      stepIndex,
      actionId,
    })
      .then((verification) => {
        sendResponse({ success: true, verification });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : 'Recheck failed',
        });
      });
    return true; // async
  } else if (message.type === 'INSPECT_PAGE_STATE') {
    const step = message.payload?.step;
    let targetFound = false;
    let targetDetails: any = null;

    if (step?.target) {
      try {
        const res = TargetResolver.resolve(step.target);
        if (res && res.element) {
          targetFound = true;
          targetDetails = {
            tagName: res.element.tagName,
            text: (res.element.innerText || '').slice(0, 100).trim(),
            confidence: res.confidence,
            isAmbiguous: res.isAmbiguous,
          };
        }
      } catch {
        targetFound = false;
      }
    }

    sendResponse({
      success: true,
      url: window.location.href,
      title: document.title,
      targetFound,
      targetDetails,
      readyState: document.readyState,
    });
    return false;
  }
});

// Check if recording is already active (e.g. after a page navigation)
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
  if (response && response.isRecording) {
    console.log("FlowOnce: Resuming recording after navigation with step count", response.stepCount);
    initializeRecorder();
    recorder?.start(response.stepCount || 0);
    showRecordingIndicator();
  }
});

// Check if a replay session is active (e.g. following page navigation)
chrome.runtime.sendMessage({ type: 'GET_REPLAY_STATUS' }, (response) => {
  if (response && response.success && response.session) {
    const session = response.session;
    if (
      session.status === 'RUNNING' ||
      session.status === 'WAITING' ||
      session.status === 'PAUSED' ||
      session.status === 'NAVIGATING'
    ) {
      console.log(
        `FlowOnce: Reconnecting HUD for active replay session ${session.sessionId} at step ${session.currentStepIndex + 1}`
      );
      showReplayIndicator(
        session.currentStepIndex + 1,
        session.totalSteps,
        session.status,
        session.workflowName
      );
      if (session.status === 'PAUSED' && replayIndicatorEl) {
        replayIndicatorEl.dataset.isPaused = 'true';
        const pauseBtn = replayIndicatorEl.querySelector('#flowonce-pause-replay-btn');
        if (pauseBtn) pauseBtn.innerHTML = '▶️ Resume';
        const statusEl = replayIndicatorEl.querySelector('#flowonce-step-status');
        if (statusEl) statusEl.innerHTML = '(Paused)';
      }
    } else if (session.status === 'RECOVERY_REQUIRED') {
      showRecoveryHUD(session, undefined, session.lastError);
    }
  }
});
