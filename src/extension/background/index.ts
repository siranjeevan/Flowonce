console.log("FlowOnce Background Service Worker started.");

import type { WorkflowStep } from '../../shared/types/workflow';
import { orchestrator } from '../../replay/ReplayOrchestrator';

chrome.runtime.onInstalled.addListener(() => {
  console.log("FlowOnce installed.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'RECORDED_STEP') {
    (async () => {
      const data = await chrome.storage.local.get(['currentSteps']);
      const currentSteps = (data.currentSteps as WorkflowStep[]) || [];
      const newStep = message.payload as WorkflowStep;

      // Consolidate consecutive 'input' steps on the same target
      if (
        newStep.type === 'input' &&
        currentSteps.length > 0 &&
        currentSteps[currentSteps.length - 1].type === 'input' &&
        currentSteps[currentSteps.length - 1].target?.selector === newStep.target?.selector
      ) {
        currentSteps[currentSteps.length - 1].value = newStep.value;
        currentSteps[currentSteps.length - 1].timestamp = newStep.timestamp; // update to latest time
        // We might want to keep the original sequence/id, so we just update value and timestamp
      } else {
        currentSteps.push(newStep);
      }
      
      await chrome.storage.local.set({ currentSteps });
      
      console.log("Background received step:", message.payload);
      
      // Broadcast to popup if open
      chrome.runtime.sendMessage({
        type: 'STEP_ADDED',
        payload: message.payload,
        totalSteps: currentSteps.length
      }).catch(() => { /* ignore error if popup is closed */ });
      
      sendResponse({ success: true });
    })();
    return true; // async
  } 
  else if (message.type === 'GET_RECORDING_STATE') {
    (async () => {
      const data = await chrome.storage.local.get(['isRecording', 'currentSteps']);
      const currentSteps = (data.currentSteps as WorkflowStep[]) || [];
      sendResponse({ 
        isRecording: (data.isRecording as boolean) || false, 
        stepCount: currentSteps.length, 
        steps: currentSteps 
      });
    })();
    return true; // async
  }
  else if (message.type === 'SET_RECORDING_STATE') {
    (async () => {
      const isRecording = message.payload;
      if (isRecording) {
        await chrome.storage.local.set({ isRecording: true, currentSteps: [] });
        // Automatically make the browser window fullscreen
        chrome.windows.getCurrent((window) => {
          if (window.id) chrome.windows.update(window.id, { state: 'fullscreen' });
        });
      } else {
        await chrome.storage.local.set({ isRecording: false });
        // Exit fullscreen when recording stops
        chrome.windows.getCurrent((window) => {
          if (window.id && window.state === 'fullscreen') {
            chrome.windows.update(window.id, { state: 'maximized' });
          }
        });
      }
      sendResponse({ success: true });
    })();
    return true; // async
  }
  else if (message.type === 'STOP_AND_SAVE_RECORDING') {
    (async () => {
      await chrome.storage.local.set({ isRecording: false });
      // Exit fullscreen when recording stops via the overlay button
      chrome.windows.getCurrent((window) => {
        if (window.id && window.state === 'fullscreen') {
          chrome.windows.update(window.id, { state: 'maximized' });
        }
      });
      // Optionally attempt to open popup if allowed by browser (Manifest V3)
      if (chrome.action && typeof chrome.action.openPopup === 'function') {
        chrome.action.openPopup().catch(() => {});
      }
      sendResponse({ success: true });
    })();
    return true; // async
  }
  else if (message.type === 'PLAY_WORKFLOW') {
    orchestrator.start(message.payload.workflow, message.payload.variables, message.payload.speedMultiplier || 1);
    sendResponse({ success: true });
  }
  else if (message.type === 'STOP_WORKFLOW') {
    orchestrator.stop();
    sendResponse({ success: true });
  }
  else if (message.type === 'CLEAR_RECORDED_STEPS') {
    (async () => {
      await chrome.storage.local.set({ currentSteps: [] });
      sendResponse({ success: true });
    })();
    return true; // async
  }
});
