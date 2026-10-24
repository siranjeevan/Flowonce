import type { Workflow, WorkflowStep } from '../shared/types/workflow';

export class ReplayOrchestrator {
  private workflow: Workflow | null = null;
  private currentStepIndex = 0;
  private isRunning = false;
  private isPaused = false;
  private variables: Record<string, string> = {};
  private speedMultiplier = 1;
  private targetTabId: number | null = null;

  public async start(workflow: Workflow, variables: Record<string, string> = {}, speedMultiplier: number = 1, tabId?: number) {
    this.workflow = workflow;
    this.variables = variables;
    this.speedMultiplier = speedMultiplier;
    this.currentStepIndex = 0;
    this.isRunning = true;
    this.isPaused = false;

    if (tabId) {
      this.targetTabId = tabId;
    } else {
      const tab = await this.getTargetTab();
      this.targetTabId = tab?.id || null;
    }

    console.log("[ReplayOrchestrator] Replay started for workflow:", workflow.id, "Target tab:", this.targetTabId);
    this.executeNextStep();
  }

  public stop() {
    this.isRunning = false;
    this.isPaused = false;
    if (this.targetTabId) {
      chrome.tabs.sendMessage(this.targetTabId, { type: 'HIDE_REPLAY_INDICATOR' }).catch(() => {});
    }
  }

  public pause() {
    this.isPaused = true;
  }

  public resume() {
    if (!this.isRunning) return;
    this.isPaused = false;
    this.executeNextStep();
  }

  private async getTargetTab(): Promise<chrome.tabs.Tab | null> {
    if (this.targetTabId) {
      try {
        const tab = await chrome.tabs.get(this.targetTabId);
        if (tab && tab.id) return tab;
      } catch {
        console.warn(`[ReplayOrchestrator] Target tab ${this.targetTabId} not available, falling back.`);
      }
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id) {
        this.targetTabId = tab.id;
        return tab;
      }
      const [anyActive] = await chrome.tabs.query({ active: true });
      if (anyActive?.id) {
        this.targetTabId = anyActive.id;
        return anyActive;
      }
    } catch {}

    return null;
  }

  private waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(false);
          return;
        }
        if (tab.status === 'complete') {
          resolve(true);
          return;
        }

        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(false);
        }, timeoutMs);

        const listener = (updatedTabId: number, changeInfo: any) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        };

        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }

  private async executeNextStep() {
    if (!this.isRunning || !this.workflow || this.currentStepIndex >= this.workflow.steps.length) {
      console.log("[ReplayOrchestrator] Replay finished or stopped", { isRunning: this.isRunning, currentStepIndex: this.currentStepIndex });
      this.isRunning = false;
      chrome.runtime.sendMessage({ type: 'REPLAY_FINISHED', workflowId: this.workflow?.id }).catch(() => {});
      const tab = await this.getTargetTab();
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'HIDE_REPLAY_INDICATOR' }).catch(() => {});
      }
      return;
    }

    if (this.isPaused) {
      return; // Wait for resume()
    }

    const step = this.workflow.steps[this.currentStepIndex];
    const preparedStep = this.prepareStepVariables(step);

    chrome.runtime.sendMessage({ 
      type: 'REPLAY_STEP_START', 
      workflowId: this.workflow.id,
      index: this.currentStepIndex,
      total: this.workflow.steps.length,
      stepType: step.type 
    }).catch(() => {});

    try {
      let currentTab = await this.getTargetTab();
      if (!currentTab || !currentTab.id) throw new Error("No active tab found for replay");

      // Only on the initial step (Step 0):
      // Navigate if the browser tab is on an empty tab or a completely different domain/website.
      // On subsequent steps, button clicks naturally drive navigation without forcing disruptive URL reloads!
      if (this.currentStepIndex === 0 && preparedStep.url && currentTab.url && currentTab.id) {
        try {
          const currentUrlObj = new URL(currentTab.url);
          const targetUrlObj = new URL(preparedStep.url);
          const isDifferentSite = 
            currentUrlObj.origin !== targetUrlObj.origin || 
            currentTab.url.startsWith('chrome://') || 
            currentTab.url.startsWith('about:');

          if (isDifferentSite) {
            console.log(`[ReplayOrchestrator] Opening workflow starting URL: ${preparedStep.url}`);
            await chrome.tabs.update(currentTab.id, { url: preparedStep.url });
            await this.waitForTabLoad(currentTab.id);
            await new Promise(r => setTimeout(r, 600));
            currentTab = await this.getTargetTab() || currentTab;
          }
        } catch (e) {
          console.warn("[ReplayOrchestrator] Initial URL check error:", e);
        }
      }

      // Resilient execution loop with retries for loading and page navigation
      let attempts = 0;
      let stepSuccess = false;
      let lastExecutionError: any = null;

      while (this.isRunning && !stepSuccess && attempts < 15) {
        if (this.isPaused) return;

        const activeTab = await this.getTargetTab();
        if (!activeTab || !activeTab.id) {
          await new Promise(r => setTimeout(r, 400));
          attempts++;
          continue;
        }

        // Wait if the tab is still loading
        if (activeTab.status === 'loading') {
          console.log(`[ReplayOrchestrator] Tab ${activeTab.id} is loading. Waiting for complete...`);
          await this.waitForTabLoad(activeTab.id);
          await new Promise(r => setTimeout(r, 500));
        }

        try {
          console.log(`[ReplayOrchestrator] Sending EXECUTE_STEP (Attempt ${attempts + 1}) to tab ${activeTab.id}`, preparedStep);
          const result = await chrome.tabs.sendMessage(activeTab.id, { 
            type: 'EXECUTE_STEP', 
            payload: { 
              step: preparedStep, 
              speedMultiplier: this.speedMultiplier,
              index: this.currentStepIndex + 1,
              total: this.workflow.steps.length
            }
          });

          if (result && result.success) {
            stepSuccess = true;
            break;
          } else {
            // Content script actively returned failure (e.g. element not found after 15s)
            // DO NOT retry in a loop! Throw immediately so the error is reported!
            throw new Error(result?.error || 'Element execution failed');
          }
        } catch (err: any) {
          lastExecutionError = err;
          const msg = err?.message || '';

          // If the element could not be found or action threw an explicit failure:
          if (msg.includes('Could not find') || msg.includes('TARGET_NOT_FOUND') || msg.includes('execution failed')) {
            throw err;
          }

          // If connection was dropped because the page navigated during click:
          const isNavigation = 
            msg.includes('message port closed') || 
            msg.includes('Receiving end does not exist') ||
            msg.includes('Frame was removed') ||
            msg.includes('Could not establish connection');

          if (isNavigation) {
            console.warn(`[ReplayOrchestrator] Connection interrupted during step (page navigation in progress): ${msg}`);
            await new Promise(r => setTimeout(r, 600));
            const freshTab = await this.getTargetTab();
            if (freshTab && freshTab.id && freshTab.status === 'loading') {
              console.log("[ReplayOrchestrator] Tab is loading following action. Waiting for completion...");
              await this.waitForTabLoad(freshTab.id);
              await new Promise(r => setTimeout(r, 600));
              // Clicks or enters that trigger page navigation are considered successful
              if (preparedStep.type === 'click' || preparedStep.type === 'keydown' || preparedStep.type === 'keypress') {
                console.log("[ReplayOrchestrator] Action successfully triggered navigation!");
                stepSuccess = true;
                break;
              }
            }
            attempts++;
            continue;
          }

          // Other transient error, wait and retry
          await new Promise(r => setTimeout(r, 400));
          attempts++;
        }
      }

      if (!stepSuccess) {
        throw lastExecutionError || new Error("Failed to execute step after multiple attempts");
      }

      // Step succeeded, advance to next
      this.currentStepIndex++;
      chrome.runtime.sendMessage({ type: 'REPLAY_STEP_SUCCESS', index: this.currentStepIndex }).catch(() => {});
      const delayMs = Math.max(200, 1000 / this.speedMultiplier);
      setTimeout(() => this.executeNextStep(), delayMs);

    } catch (e: any) {
      this.isRunning = false;
      const errorMsg = e.message || 'Unknown error occurred during replay.';
      console.error("[ReplayOrchestrator] Replay failed at step", this.currentStepIndex, errorMsg);
      
      chrome.runtime.sendMessage({ 
        type: 'REPLAY_FAILED', 
        workflowId: this.workflow?.id,
        error: errorMsg, 
        index: this.currentStepIndex 
      }).catch(() => {});

      const tab = await this.getTargetTab();
      if (tab?.id) {
        // If tab is loading, wait for it so the content script can receive and render the error HUD
        if (tab.status === 'loading') {
          await this.waitForTabLoad(tab.id);
          await new Promise(r => setTimeout(r, 500));
        }
        chrome.tabs.sendMessage(tab.id, { 
          type: 'SHOW_REPLAY_ERROR',
          payload: { error: errorMsg }
        }).catch(() => {});
      }
    }
  }

  private prepareStepVariables(step: WorkflowStep): WorkflowStep {
    const cloned = { ...step };
    if (cloned.value) {
      cloned.value = cloned.value.replace(/{{([^}]+)}}/g, (_, varName) => {
        return this.variables[varName] || `{{${varName}}}`;
      });
    }
    return cloned;
  }
}

export const orchestrator = new ReplayOrchestrator();
