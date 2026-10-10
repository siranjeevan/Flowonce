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
  else if (message.type === 'PAUSE_WORKFLOW') {
    orchestrator.pause();
    sendResponse({ success: true });
  }
  else if (message.type === 'RESUME_WORKFLOW') {
    orchestrator.resume();
    sendResponse({ success: true });
  }
  else if (message.type === 'CLEAR_RECORDED_STEPS') {
    (async () => {
      await chrome.storage.local.set({ currentSteps: [] });
      sendResponse({ success: true });
    })();
    return true; // async
  }
  else if (message.type === 'SAVE_WORKFLOW_FROM_CONTENT') {
    (async () => {
      try {
        const data = await chrome.storage.local.get(['currentSteps']);
        const currentSteps = (data.currentSteps as WorkflowStep[]) || [];
        if (currentSteps.length === 0) {
          sendResponse({ success: false, error: 'No steps to save' });
          return;
        }
        
        const workflow = {
          id: `WF_${Date.now().toString(36).toUpperCase()}`,
          name: message.payload.name || `Workflow ${new Date().toLocaleString()}`,
          description: 'Recorded workflow',
          ownerId: 'local_user',
          version: 1,
          schemaVersion: 1,
          steps: [...currentSteps],
          variables: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        const storageData = await chrome.storage.local.get(['workflows']);
        const workflows = (storageData.workflows as any[]) || [];
        workflows.push(workflow);
        await chrome.storage.local.set({ workflows, currentSteps: [], isRecording: false });
        
        // Exit fullscreen when recording stops via the overlay button
        chrome.windows.getCurrent((window) => {
          if (window.id && window.state === 'fullscreen') {
            chrome.windows.update(window.id, { state: 'maximized' });
          }
        });
        
        sendResponse({ success: true });
      } catch (err: any) {
        console.error("Failed to save workflow:", err);
        sendResponse({ success: false, error: err.message || 'Unknown error' });
      }
    })();
    return true; // async
  }
});
