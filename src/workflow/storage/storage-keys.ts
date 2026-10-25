/**
 * Storage Keys Specification for FlowOnce
 * 
 * PERSISTENCE SCOPE ARCHITECTURE:
 * - Extension Local Storage (chrome.storage.local):
 *   Shared exclusively within the FlowOnce Chrome Extension environment
 *   (Background Service Worker, Popup UI, Options).
 *   Data persists across browser restarts and is sandboxed from web pages.
 *   This is the CANONICAL persistence tier for user workflows, settings, and migration backups.
 * 
 * - Browser Page Storage (window.localStorage):
 *   Scoped to individual webpage origins. NOT used for cross-origin workflow persistence.
 *   Content scripts communicate with the background worker via runtime messaging
 *   to read/write workflows rather than accessing page local storage.
 */

export const STORAGE_KEYS = {
  /** Canonical key for versioned, validated workflows */
  WORKFLOWS: 'flowonce.workflows',
  /** Current storage schema version number */
  SCHEMA_VERSION: 'flowonce.storageSchemaVersion',
  /** Key storing legacy migration audit logs and backup snapshots */
  MIGRATION_BACKUP: 'flowonce.migrationBackup',
  /** In-storage timestamp lock to coordinate cross-context initialization */
  MIGRATION_LOCK: 'flowonce.migrationLock',
  /** Session recording state keys (transient execution state) */
  CURRENT_STEPS: 'currentSteps',
  IS_RECORDING: 'isRecording',
  /** Canonical key for persistent replay session state */
  ACTIVE_SESSION: 'flowonce.activeReplaySession',
  /** Schema version for persistent replay sessions */
  SESSION_SCHEMA_VERSION: 'flowonce.sessionSchemaVersion',
  /** Historical archived sessions */
  SESSION_HISTORY: 'flowonce.replaySessionHistory',
  /** Reusable workflow components */
  COMPONENTS: 'flowonce.components',
  /** User-defined and cached templates */
  TEMPLATES: 'flowonce.templates',
  /** Scheduled workflow automation */
  SCHEDULES: 'flowonce.schedules',
  /** Safe API integrations configuration */
  INTEGRATIONS: 'flowonce.integrations',
  /** Workflow execution analytics and run history */
  EXECUTION_HISTORY: 'flowonce.executionHistory',
  /** Team collaboration and sharing permissions */
  COLLABORATION: 'flowonce.collaboration',
} as const;

export const LEGACY_STORAGE_KEYS = {
  /** Key previously used by background SAVE_WORKFLOW_FROM_CONTENT and App.tsx cloud sync */
  LEGACY_WORKFLOWS: 'workflows',
  /** Key previously used by LocalStorageManager */
  LEGACY_FLOWONCE_WORKFLOWS: 'flowonce_workflows',
} as const;

/** Current canonical schema version for workflow entities */
export const CURRENT_SCHEMA_VERSION = 2;

/** Current canonical schema version for persistent replay sessions */
export const CURRENT_SESSION_SCHEMA_VERSION = 1;
