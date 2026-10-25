console.log("FlowOnce Background Service Worker started.");

import type { WorkflowStep } from '../../shared/types/workflow';
import { orchestrator } from '../../replay/ReplayOrchestrator';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { validateWorkflow } from '../../workflow/storage/schema';
import { ReplaySessionStorage } from '../../replay/session/ReplaySessionStorage';

// Initialize storage & reconcile replay sessions on service worker boot
WorkflowStorage.ensureInitialized().catch((err) => {
  console.error('[Background] WorkflowStorage initialization failed:', err);
});
orchestrator.reconcileSessionOnBoot().catch((err) => {
  console.error('[Background] Replay session reconciliation failed on boot:', err);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("FlowOnce installed.");
  WorkflowStorage.ensureInitialized().catch((err) => {
    console.error('[Background] WorkflowStorage onInstalled initialization failed:', err);
  });
  orchestrator.reconcileSessionOnBoot().catch((err) => {
    console.error('[Background] Session reconciliation failed onInstalled:', err);
  });
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
      } else {
        await chrome.storage.local.set({ isRecording: false });
      }
      sendResponse({ success: true });
    })();
    return true; // async
  }
  else if (message.type === 'STOP_AND_SAVE_RECORDING') {
    (async () => {
      await chrome.storage.local.set({ isRecording: false });
      // Optionally attempt to open popup if allowed by browser (Manifest V3)
      if (chrome.action && typeof chrome.action.openPopup === 'function') {
        chrome.action.openPopup().catch(() => {});
      }
      sendResponse({ success: true });
    })();
    return true; // async
  }
  else if (message.type === 'PLAY_WORKFLOW') {
    (async () => {
      const rawWorkflow = message.payload?.workflow;
      const validation = validateWorkflow(rawWorkflow);

      if (!validation.valid) {
        const errorMsg = `Cannot replay invalid workflow: ${validation.errors.map(e => `[${e.field}] ${e.message}`).join(', ')}`;
        console.error('[Background]', errorMsg);
        sendResponse({ success: false, error: errorMsg });
        return;
      }

      const result = await orchestrator.start(
        rawWorkflow, 
        message.payload.variables, 
        message.payload.speedMultiplier || 1,
        message.payload.tabId
      );

      sendResponse(result);
    })();
    return true; // async
  }
  else if (message.type === 'GET_REPLAY_STATUS') {
    (async () => {
      const session = orchestrator.getSession() || await ReplaySessionStorage.getActiveSession();
      sendResponse({ success: true, session });
    })();
    return true; // async
  }
  else if (message.type === 'STOP_WORKFLOW') {
    (async () => {
      const stopped = await orchestrator.stop(message.payload?.sessionId);
      sendResponse({ success: stopped });
    })();
    return true;
  }
  else if (message.type === 'PAUSE_WORKFLOW') {
    (async () => {
      const paused = await orchestrator.pause(message.payload?.sessionId);
      sendResponse({ success: paused });
    })();
    return true;
  }
  else if (message.type === 'RESUME_WORKFLOW') {
    (async () => {
      const resumed = await orchestrator.resume(
        message.payload?.sessionId,
        message.payload?.options || message.payload
      );
      sendResponse({ success: resumed });
    })();
    return true;
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
          name: message.payload?.name || `Workflow ${new Date().toLocaleString()}`,
          description: 'Recorded workflow',
          ownerId: 'local_user',
          version: 1,
          schemaVersion: 2,
          steps: [...currentSteps],
          variables: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        // Persist using centralized, validated WorkflowStorage
        const savedWorkflow = await WorkflowStorage.createWorkflow(workflow);
        await chrome.storage.local.set({ currentSteps: [], isRecording: false });
        
        sendResponse({ success: true, workflow: savedWorkflow });
      } catch (err: unknown) {
        console.error("Failed to save workflow:", err);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        sendResponse({ success: false, error: errorMsg });
      }
    })();
    return true; // async
  }
});
