import type { WorkflowSchedule } from './scheduler-types';
import { STORAGE_KEYS } from '../../workflow/storage/storage-keys';
import { WorkflowStorage } from '../../workflow/storage/WorkflowStorage';
import { classifyActionSafety } from '../../replay/ActionVerifier';
import { ReplayOrchestrator } from '../../replay/ReplayOrchestrator';

export class ScheduleManager {
  private static ALARM_PREFIX = 'FLOWONCE_SCHED_';

  /**
   * Retrieves all persisted schedules
   */
  static async getAllSchedules(): Promise<WorkflowSchedule[]> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return [];
    }
    const res = await chrome.storage.local.get(STORAGE_KEYS.SCHEDULES);
    const raw = res[STORAGE_KEYS.SCHEDULES];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Retrieves a schedule by its ID
   */
  static async getSchedule(id: string): Promise<WorkflowSchedule | null> {
    const all = await this.getAllSchedules();
    return all.find((s) => s.id === id) || null;
  }

  /**
   * Creates or updates a schedule
   */
  static async saveSchedule(schedule: WorkflowSchedule): Promise<WorkflowSchedule> {
    const all = await this.getAllSchedules();
    const existingIndex = all.findIndex((s) => s.id === schedule.id);

    // Validate workflow exists
    const wf = await WorkflowStorage.getWorkflow(schedule.workflowId);
    if (!wf) {
      throw new Error(`Target workflow "${schedule.workflowId}" does not exist`);
    }

    // Require explicit user authorization for scheduled workflows that perform side effects
    const hasSideEffects = wf.steps.some((s) =>
      ['click', 'input', 'select', 'checkbox', 'radio', 'paste', 'keydown', 'keypress', 'drag'].includes(s.type)
    );
    if (hasSideEffects && !schedule.forceUnsafeAuthorization) {
      throw new Error(
        `Explicit authorization is required for scheduled workflow "${wf.name}" because it contains side-effecting actions.`
      );
    }

    // Calculate next run time
    const nextRun = this.calculateNextRun(schedule);
    const toSave: WorkflowSchedule = {
      ...schedule,
      workflowName: wf.name,
      nextRun,
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      all[existingIndex] = toSave;
    } else {
      all.push(toSave);
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SCHEDULES]: all });
    }

    // Synchronize Chrome alarm
    if (toSave.enabled) {
      await this.registerAlarm(toSave);
    } else {
      await this.clearAlarm(toSave.id);
    }

    return toSave;
  }

  /**
   * Deletes a schedule and cancels its alarm
   */
  static async deleteSchedule(id: string): Promise<boolean> {
    const all = await this.getAllSchedules();
    const filtered = all.filter((s) => s.id !== id);
    if (filtered.length === all.length) return false;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SCHEDULES]: filtered });
    }

    await this.clearAlarm(id);
    return true;
  }

  /**
   * Toggles enabled state of a schedule
   */
  static async toggleSchedule(id: string, enabled: boolean): Promise<WorkflowSchedule | null> {
    const schedule = await this.getSchedule(id);
    if (!schedule) return null;
    schedule.enabled = enabled;
    return this.saveSchedule(schedule);
  }

  /**
   * Re-creates all active alarms upon Chrome Extension service worker startup
   */
  static async initializeSchedulerOnBoot(): Promise<void> {
    console.log('[ScheduleManager] Initializing schedules on service worker boot...');
    const schedules = await this.getAllSchedules();

    for (const schedule of schedules) {
      if (schedule.enabled) {
        try {
          await this.registerAlarm(schedule);
        } catch (err) {
          console.error(`[ScheduleManager] Failed to register alarm for schedule ${schedule.id}:`, err);
        }
      }
    }
  }

  /**
   * Handles an alarm firing event from chrome.alarms.onAlarm
   */
  static async handleAlarm(alarmName: string): Promise<void> {
    if (!alarmName.startsWith(this.ALARM_PREFIX)) return;
    const scheduleId = alarmName.replace(this.ALARM_PREFIX, '');

    const schedule = await this.getSchedule(scheduleId);
    if (!schedule || !schedule.enabled) return;

    await this.executeScheduledWorkflow(schedule);
  }

  /**
   * Executes a scheduled workflow with safety gate and tab allocation
   */
  static async executeScheduledWorkflow(schedule: WorkflowSchedule): Promise<void> {
    const wf = await WorkflowStorage.getWorkflow(schedule.workflowId);
    if (!wf) {
      schedule.lastStatus = 'ERROR';
      schedule.lastErrorMessage = `Workflow "${schedule.workflowId}" not found`;
      schedule.lastRun = Date.now();
      await this.saveSchedule(schedule);
      return;
    }

    // Safety Gate: Check for external side-effecting actions
    const hasSideEffects = wf.steps.some((step) => {
      const cat = classifyActionSafety(step);
      return cat === 'EXTERNAL_SIDE_EFFECT' || cat === 'TOGGLE_STATE';
    });

    if (hasSideEffects && !schedule.forceUnsafeAuthorization) {
      console.warn(
        `[ScheduleManager] Refusing automated execution for schedule "${schedule.name}". ` +
        `Workflow contains side-effecting actions and lacks explicit forceUnsafeAuthorization.`
      );
      schedule.lastStatus = 'REFUSED_SIDE_EFFECT';
      schedule.lastErrorMessage = 'Execution blocked: side-effecting actions require explicit user authorization';
      schedule.lastRun = Date.now();
      await this.saveSchedule(schedule);
      return;
    }

    // Tab acquisition: find active or create background execution tab
    let tabId: number | null = null;
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].id) {
          tabId = tabs[0].id;
        } else {
          // Open or use new tab
          const newTab = await chrome.tabs.create({ url: wf.steps[0]?.url || 'about:blank', active: false });
          tabId = newTab.id || null;
        }
      } catch (e) {
        console.warn('[ScheduleManager] Could not query or create tab:', e);
      }
    }

    try {
      const orchestrator = ReplayOrchestrator.getInstance();
      const res = await orchestrator.start(wf, {}, 1, tabId || 1);

      schedule.lastRun = Date.now();
      schedule.lastStatus = res.success ? 'SUCCESS' : 'FAILED';
      schedule.lastErrorMessage = res.error;
    } catch (err: any) {
      schedule.lastRun = Date.now();
      schedule.lastStatus = 'FAILED';
      schedule.lastErrorMessage = err?.message || 'Execution failed';
    } finally {
      // If one-time schedule, disable it
      if (schedule.type === 'once') {
        schedule.enabled = false;
        await this.clearAlarm(schedule.id);
      }
      await this.saveSchedule(schedule);
    }
  }

  private static calculateNextRun(schedule: WorkflowSchedule): number {
    const now = Date.now();
    if (schedule.type === 'once') {
      return schedule.scheduledTime && schedule.scheduledTime > now ? schedule.scheduledTime : now + 60000;
    }
    if (schedule.type === 'interval') {
      const intervalMs = Math.max(1, schedule.intervalMinutes || 60) * 60 * 1000;
      return now + intervalMs;
    }
    if (schedule.type === 'daily' && schedule.dailyTime) {
      const [hours, minutes] = schedule.dailyTime.split(':').map((v) => parseInt(v, 10));
      const target = new Date();
      target.setHours(hours || 0, minutes || 0, 0, 0);
      if (target.getTime() <= now) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }
    return now + 3600000;
  }

  private static async registerAlarm(schedule: WorkflowSchedule): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;

    const alarmName = `${this.ALARM_PREFIX}${schedule.id}`;
    await this.clearAlarm(schedule.id);

    if (schedule.type === 'once') {
      const when = schedule.scheduledTime && schedule.scheduledTime > Date.now()
        ? schedule.scheduledTime
        : Date.now() + 60000;
      chrome.alarms.create(alarmName, { when });
    } else if (schedule.type === 'interval') {
      const period = Math.max(1, schedule.intervalMinutes || 15);
      chrome.alarms.create(alarmName, {
        delayInMinutes: period,
        periodInMinutes: period,
      });
    } else if (schedule.type === 'daily' && schedule.dailyTime) {
      const when = this.calculateNextRun(schedule);
      chrome.alarms.create(alarmName, {
        when,
        periodInMinutes: 24 * 60,
      });
    }
  }

  private static async clearAlarm(scheduleId: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    const alarmName = `${this.ALARM_PREFIX}${scheduleId}`;
    try {
      await chrome.alarms.clear(alarmName);
    } catch {
      // Ignore
    }
  }
}
