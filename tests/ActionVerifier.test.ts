import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActionVerifier, isActionIdempotent } from '../src/replay/ActionVerifier';
import { PostconditionEvaluator } from '../src/replay/PostconditionEvaluator';
import { ActionExecutor } from '../src/replay/ActionExecutor';
import { ReplayOrchestrator } from '../src/replay/ReplayOrchestrator';
import { ReplaySessionStorage } from '../src/replay/session/ReplaySessionStorage';
import { WorkflowStorage } from '../src/workflow/storage/WorkflowStorage';
import { validateStepVerificationConfig } from '../src/workflow/storage/schema';
import type { WorkflowStep, Workflow } from '../src/shared/types/workflow';
import type { PostconditionDescriptor } from '../src/replay/verification-types';

describe('Phase 6: Action Verification and Postcondition Engine', () => {
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    document.body.innerHTML = '';
    mockStorage = {};

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | null) => {
            if (!keys) return { ...mockStorage };
            if (typeof keys === 'string') return { [keys]: mockStorage[keys] };
            if (Array.isArray(keys)) {
              const res: Record<string, any> = {};
              for (const k of keys) res[k] = mockStorage[k];
              return res;
            }
            return { ...mockStorage };
          }),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign(mockStorage, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete mockStorage[k];
          }),
          clear: vi.fn(async () => {
            mockStorage = {};
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          if (tabId === 999) throw new Error('Tab not found');
          return { id: tabId, status: 'complete', url: 'https://example.com' };
        }),
        query: vi.fn(async () => [{ id: 101, status: 'complete', url: 'https://example.com' }]),
        update: vi.fn(async () => ({})),
        sendMessage: vi.fn(async (_tabId: number, message: any) => {
          if (message.type === 'EXECUTE_STEP') return { success: true };
          if (message.type === 'CHECK_ACTION_EXECUTED') return { success: true, executed: true };
          return { success: true };
        }),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({})),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Postcondition Evaluation Fundamentals
  // =========================================================================
  describe('Group 1: Postcondition Evaluation Fundamentals', () => {
    it('1.1 element_exists & element_visible succeeds when element is present and visible', async () => {
      const btn = document.createElement('button');
      btn.id = 'target-btn';
      btn.textContent = 'Save';
      Object.defineProperty(btn, 'offsetWidth', { value: 100, configurable: true });
      Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true });
      document.body.appendChild(btn);

      const existsDesc: PostconditionDescriptor = {
        type: 'element_exists',
        target: { id: 'target-btn', tag: 'button' },
      };
      const existsResult = await PostconditionEvaluator.evaluate(existsDesc, undefined, 500);
      expect(existsResult.satisfied).toBe(true);

      const visibleDesc: PostconditionDescriptor = {
        type: 'element_visible',
        target: { id: 'target-btn', tag: 'button' },
      };
      const visibleResult = await PostconditionEvaluator.evaluate(visibleDesc, undefined, 500);
      expect(visibleResult.satisfied).toBe(true);
    });

    it('1.2 element_visible detects delayed element appearance via DOM mutation', async () => {
      setTimeout(() => {
        const modal = document.createElement('div');
        modal.id = 'modal-dialog';
        modal.textContent = 'Confirm Action';
        Object.defineProperty(modal, 'offsetWidth', { value: 300, configurable: true });
        Object.defineProperty(modal, 'offsetHeight', { value: 200, configurable: true });
        document.body.appendChild(modal);
      }, 50);

      const visibleDesc: PostconditionDescriptor = {
        type: 'element_visible',
        target: { id: 'modal-dialog', tag: 'div' },
      };
      const res = await PostconditionEvaluator.evaluate(visibleDesc, undefined, 1000);
      expect(res.satisfied).toBe(true);
    });

    it('1.3 element_absent detects element removal from DOM', async () => {
      const spinner = document.createElement('div');
      spinner.id = 'loading-spinner';
      document.body.appendChild(spinner);

      setTimeout(() => {
        spinner.remove();
      }, 40);

      const absentDesc: PostconditionDescriptor = {
        type: 'element_absent',
        target: { id: 'loading-spinner', tag: 'div' },
      };
      const res = await PostconditionEvaluator.evaluate(absentDesc, undefined, 1000);
      expect(res.satisfied).toBe(true);
    });

    it('1.4 element_enabled and element_disabled evaluate control state', async () => {
      const input = document.createElement('input');
      input.id = 'code-field';
      input.disabled = true;
      document.body.appendChild(input);

      const disabledDesc: PostconditionDescriptor = {
        type: 'element_disabled',
        target: { id: 'code-field', tag: 'input' },
      };
      const res1 = await PostconditionEvaluator.evaluate(disabledDesc, undefined, 500);
      expect(res1.satisfied).toBe(true);

      setTimeout(() => {
        input.disabled = false;
      }, 30);

      const enabledDesc: PostconditionDescriptor = {
        type: 'element_enabled',
        target: { id: 'code-field', tag: 'input' },
      };
      const res2 = await PostconditionEvaluator.evaluate(enabledDesc, undefined, 1000);
      expect(res2.satisfied).toBe(true);
    });

    it('1.5 text_equals and text_contains evaluate text content accurately', async () => {
      const statusDiv = document.createElement('div');
      statusDiv.id = 'status-msg';
      statusDiv.textContent = 'Order #12345 confirmed successfully';
      document.body.appendChild(statusDiv);

      const containsDesc: PostconditionDescriptor = {
        type: 'text_contains',
        target: { id: 'status-msg', tag: 'div' },
        expectedValue: 'confirmed successfully',
      };
      const res1 = await PostconditionEvaluator.evaluate(containsDesc, undefined, 500);
      expect(res1.satisfied).toBe(true);

      const equalsDesc: PostconditionDescriptor = {
        type: 'text_equals',
        target: { id: 'status-msg', tag: 'div' },
        expectedValue: 'Order #12345 confirmed successfully',
      };
      const res2 = await PostconditionEvaluator.evaluate(equalsDesc, undefined, 500);
      expect(res2.satisfied).toBe(true);
    });

    it('1.6 attribute_equals verifies specified DOM attribute value', async () => {
      const toggle = document.createElement('button');
      toggle.id = 'menu-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      document.body.appendChild(toggle);

      setTimeout(() => {
        toggle.setAttribute('aria-expanded', 'true');
      }, 30);

      const attrDesc: PostconditionDescriptor = {
        type: 'attribute_equals',
        target: { id: 'menu-toggle', tag: 'button' },
        attributeName: 'aria-expanded',
        expectedValue: 'true',
      };
      const res = await PostconditionEvaluator.evaluate(attrDesc, undefined, 1000);
      expect(res.satisfied).toBe(true);
    });

    it('1.7 url_changed and url_matches evaluate location accurately', async () => {
      const current = typeof window !== 'undefined' ? window.location?.href || 'https://example.com' : 'https://example.com';
      const context = { initialUrl: 'https://example.com/checkout' };

      const urlMatchesDesc: PostconditionDescriptor = {
        type: 'url_matches',
        urlPattern: current,
      };
      const res = await PostconditionEvaluator.evaluate(urlMatchesDesc, context, 500);
      expect(res.satisfied).toBe(true);

      const urlChangedDesc: PostconditionDescriptor = {
        type: 'url_changed',
      };
      const changedRes = await PostconditionEvaluator.evaluate(urlChangedDesc, context, 500);
      expect(changedRes.satisfied).toBe(true);
    });
  });

  // =========================================================================
  // 2. Framework & Form Control Verification
  // =========================================================================
  describe('Group 2: Framework & Form Control Verification', () => {
    it('2.1 Controlled input value_equals accesses native prototype value (React/Vue pattern)', async () => {
      const input = document.createElement('input');
      input.id = 'react-input';
      document.body.appendChild(input);

      // Simulate React 18 overridden value property tracker
      let internalVal = '';
      Object.defineProperty(input, 'value', {
        get() {
          return internalVal;
        },
        set(val) {
          internalVal = val;
        },
        configurable: true,
      });

      input.value = 'John Doe';

      const desc: PostconditionDescriptor = {
        type: 'value_equals',
        target: { id: 'react-input', tag: 'input' },
        expectedValue: 'John Doe',
      };

      const outcome = await PostconditionEvaluator.evaluate(desc, undefined, 500);
      expect(outcome.satisfied).toBe(true);
      expect(outcome.actualState).toContain('John Doe');
    });

    it('2.2 Checkbox verification confirms checked/unchecked state', async () => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'agree-terms';
      checkbox.checked = false;
      document.body.appendChild(checkbox);

      const step: WorkflowStep = {
        id: 's_check',
        type: 'checkbox',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'true',
        target: { id: 'agree-terms', tag: 'input' },
      };

      // Set checked as ActionExecutor would
      checkbox.checked = true;

      const verification = await ActionVerifier.verifyAction(step, checkbox);
      expect(verification.status).toBe('VERIFIED');
      expect(verification.method).toBe('auto_checkbox_checked_state');
    });

    it('2.3 Radio button verification confirms expected checked state', async () => {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.id = 'opt-standard';
      radio.checked = true;
      document.body.appendChild(radio);

      const step: WorkflowStep = {
        id: 's_radio',
        type: 'radio',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'true',
        target: { id: 'opt-standard', tag: 'input' },
      };

      const verification = await ActionVerifier.verifyAction(step, radio);
      expect(verification.status).toBe('VERIFIED');
      expect(verification.method).toBe('auto_radio_checked_state');
    });

    it('2.4 ActionExecutor.executeSelect sets select value and verifies', async () => {
      const select = document.createElement('select');
      select.id = 'country-select';
      select.innerHTML = `
        <option value="us">United States</option>
        <option value="ca">Canada</option>
        <option value="uk">United Kingdom</option>
      `;
      Object.defineProperty(select, 'offsetWidth', { value: 120, configurable: true });
      Object.defineProperty(select, 'offsetHeight', { value: 30, configurable: true });
      document.body.appendChild(select);

      const step: WorkflowStep = {
        id: 's_select',
        type: 'select',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'ca',
        target: { id: 'country-select', tag: 'select' },
      };

      const res = await ActionExecutor.executeWithVerification(step);
      expect(res.success).toBe(true);
      expect(select.value).toBe('ca');
      expect(res.verification.status).toBe('VERIFIED');
    });
  });

  // =========================================================================
  // 3. Timeouts, Idempotency & Retry Eligibility
  // =========================================================================
  describe('Group 3: Timeouts, Idempotency & Retry Eligibility', () => {
    it('3.1 isActionIdempotent correctly categorizes actions', () => {
      expect(isActionIdempotent('input')).toBe(true);
      expect(isActionIdempotent('checkbox')).toBe(true);
      expect(isActionIdempotent('radio')).toBe(true);
      expect(isActionIdempotent('select')).toBe(true);
      expect(isActionIdempotent('scroll')).toBe(true);
      expect(isActionIdempotent('wait')).toBe(true);
      expect(isActionIdempotent('navigate')).toBe(true);

      // Non-idempotent
      expect(isActionIdempotent('click')).toBe(false);
      expect(isActionIdempotent('keydown')).toBe(false);
      expect(isActionIdempotent('keypress')).toBe(false);
    });

    it('3.2 Non-idempotent action (click) timing out yields OUTCOME_UNKNOWN and VERIFY_ONLY', async () => {
      const btn = document.createElement('button');
      btn.id = 'purchase-btn';
      btn.textContent = 'Pay $100';
      document.body.appendChild(btn);

      // A click step expecting a confirmation banner that never appears
      const step: WorkflowStep = {
        id: 's_click_pay',
        type: 'click',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        target: { id: 'purchase-btn', tag: 'button' },
        verification: {
          enabled: true,
          strategy: 'element_visible',
          postcondition: {
            type: 'element_visible',
            target: { id: 'non-existent-order-confirmation', tag: 'div' },
          },
          timeoutMs: 100, // short timeout for test
        },
      };

      const result = await ActionVerifier.verifyAction(step, btn);
      expect(result.status).toBe('OUTCOME_UNKNOWN');
      expect(result.retryEligibility).toBe('VERIFY_ONLY');
      expect(result.recoveryRecommendation).toContain('Do not automatically repeat');
    });

    it('3.3 Idempotent action (input) timing out yields NOT_VERIFIED and SAFE_ACTION_RETRY', async () => {
      const input = document.createElement('input');
      input.id = 'field-retry';
      input.value = 'old_value';
      document.body.appendChild(input);

      const step: WorkflowStep = {
        id: 's_input_retry',
        type: 'input',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'expected_new_value',
        target: { id: 'field-retry', tag: 'input' },
        verification: {
          enabled: true,
          strategy: 'value_match',
          postcondition: {
            type: 'value_equals',
            target: { id: 'field-retry', tag: 'input' },
            expectedValue: 'expected_new_value',
          },
          timeoutMs: 100,
        },
      };

      const result = await ActionVerifier.verifyAction(step, input);
      expect(result.status).toBe('NOT_VERIFIED');
      expect(result.retryEligibility).toBe('SAFE_ACTION_RETRY');
    });

    it('3.4 Cancellation via AbortSignal aborts verification immediately', async () => {
      const controller = new AbortController();
      controller.abort();

      const step: WorkflowStep = {
        id: 's_abort',
        type: 'click',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        verification: {
          enabled: true,
          strategy: 'element_visible',
          postcondition: {
            type: 'element_visible',
            target: { id: 'dialog', tag: 'div' },
          },
          timeoutMs: 5000,
        },
      };

      const result = await ActionVerifier.verifyAction(step, null, {
        signal: controller.signal,
      });

      expect(result.status).toBe('CANCELLED');
      expect(result.retryEligibility).toBe('NONE');
    });
  });

  // =========================================================================
  // 4. Sanitization & Diagnostics Security
  // =========================================================================
  describe('Group 4: Sanitization & Diagnostics Security', () => {
    it('4.1 Sensitive field inputs redact value with •••••••• in diagnostics', async () => {
      const pwd = document.createElement('input');
      pwd.type = 'password';
      pwd.id = 'user-pwd';
      pwd.value = 'superSecretPassword123';
      document.body.appendChild(pwd);

      const step: WorkflowStep = {
        id: 's_pwd',
        type: 'input',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'superSecretPassword123',
        sensitive: true,
        target: { id: 'user-pwd', tag: 'input' },
      };

      const result = await ActionVerifier.verifyAction(step, pwd);
      expect(result.status).toBe('VERIFIED');
      expect(result.expectedCondition).not.toContain('superSecretPassword123');
      expect(result.expectedCondition).toContain('••••••••');
      expect(result.actualState).not.toContain('superSecretPassword123');
      expect(result.actualState).toContain('••••••••');
    });

    it('4.2 Diagnostic strings sanitize password, bearer tokens, and secrets', async () => {
      const input = document.createElement('input');
      input.id = 'token-field';
      input.value = 'dummy';
      document.body.appendChild(input);

      const step: WorkflowStep = {
        id: 's_token',
        type: 'input',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        value: 'dummy',
        verification: {
          enabled: true,
          strategy: 'custom',
          postcondition: {
            type: 'text_equals',
            expectedValue: 'Bearer ya29.secretToken12345',
          },
          timeoutMs: 100,
        },
      };

      const result = await ActionVerifier.verifyAction(step, input);
      expect(result.expectedCondition).toContain('[REDACTED]');
      expect(result.expectedCondition).not.toContain('ya29.secretToken12345');
    });
  });

  // =========================================================================
  // 5. Schema Validation & Backward Compatibility
  // =========================================================================
  describe('Group 5: Schema Validation & Backward Compatibility', () => {
    it('5.1 Validates valid verification configuration', () => {
      const validConfig = {
        enabled: true,
        strategy: 'element_visible',
        postcondition: {
          type: 'element_visible',
          target: { id: 'banner', tag: 'div' },
        },
        timeoutMs: 3000,
        pauseOnFailure: true,
      };

      const errors = validateStepVerificationConfig(validConfig);
      expect(errors).toHaveLength(0);
    });

    it('5.2 Rejects invalid timeout or invalid strategy', () => {
      const invalidConfig = {
        enabled: true,
        strategy: 'unsupported_strat',
        timeoutMs: 100000, // exceeds 60000ms max
      };

      const errors = validateStepVerificationConfig(invalidConfig);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('5.3 Old workflows without verification property execute cleanly', async () => {
      const btn = document.createElement('button');
      btn.id = 'old-style-btn';
      btn.textContent = 'Continue';
      document.body.appendChild(btn);

      const legacyStep: WorkflowStep = {
        id: 's_legacy',
        type: 'click',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        target: { id: 'old-style-btn', tag: 'button' },
      };

      const res = await ActionExecutor.executeWithVerification(legacyStep);
      expect(res.success).toBe(true);
      expect(res.verification.status).toBe('VERIFIED');
      expect(res.verification.method).toBe('dom_dispatch_acknowledged');
    });
  });

  // =========================================================================
  // 6. Replay Orchestrator Integration & Session Persistence
  // =========================================================================
  describe('Group 6: Replay Orchestrator Integration & Session Persistence', () => {
    it('6.1 OUTCOME_UNKNOWN causes orchestrator to pause session in RECOVERY_REQUIRED without auto-retry', async () => {
      const wf: Workflow = {
        id: 'wf_recovery',
        name: 'Order Workflow',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        schemaVersion: 2,
        steps: [
          {
            id: 'step_order',
            type: 'click',
            timestamp: 100,
            url: 'https://example.com',
            sequence: 1,
            target: { id: 'submit-order', tag: 'button' },
          },
        ],
      };
      await WorkflowStorage.createWorkflow(wf);

      // Mock content script returning OUTCOME_UNKNOWN
      let dispatchCount = 0;
      (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, msg: any) => {
        if (msg.type === 'EXECUTE_STEP') {
          dispatchCount++;
          return {
            success: false,
            actionId: msg.payload.actionId,
            verification: {
              verificationId: 'VER_123',
              actionId: msg.payload.actionId,
              status: 'OUTCOME_UNKNOWN',
              retryEligibility: 'VERIFY_ONLY',
              recoveryRecommendation: 'Do not automatically repeat non-idempotent action.',
              diagnosticInfo: 'Expected confirmation dialog did not appear',
            },
          };
        }
        return { success: true };
      });

      const orchestrator = new ReplayOrchestrator();
      await orchestrator.start(wf, {}, 1, 101);

      // Wait a moment for async loop
      await new Promise((r) => setTimeout(r, 100));

      const session = await ReplaySessionStorage.getActiveSession();
      // Must NOT repeat dispatch! Must be exactly 1 dispatch attempt
      expect(dispatchCount).toBe(1);
      expect(session?.status).toBe('RECOVERY_REQUIRED');
      expect(session?.actionState).toBe('OUTCOME_UNKNOWN');

      await orchestrator.stop();
    });

    it('6.2 Safe recovery resumption: user can force advance to next step', async () => {
      const wf: Workflow = {
        id: 'wf_recovery_advance',
        name: 'Two Step Workflow',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        schemaVersion: 2,
        steps: [
          {
            id: 'step_1',
            type: 'click',
            timestamp: 100,
            url: 'https://test.com',
            sequence: 1,
            target: { id: 'btn-1', tag: 'button' },
          },
          {
            id: 'step_2',
            type: 'wait',
            timestamp: 200,
            url: 'https://test.com',
            sequence: 2,
            value: '50',
          },
        ],
      };
      await WorkflowStorage.createWorkflow(wf);

      // Setup session in RECOVERY_REQUIRED
      const initialSession = {
        sessionId: 'SES_RECOVERY_TEST',
        workflowId: 'wf_recovery_advance',
        workflowName: 'Two Step Workflow',
        workflowSchemaVersion: 2,
        sessionSchemaVersion: 1,
        totalSteps: 2,
        targetTabId: 101,
        currentStepIndex: 0,
        lastCompletedStepIndex: -1,
        status: 'RECOVERY_REQUIRED' as const,
        actionState: 'OUTCOME_UNKNOWN' as const,
        currentActionId: 'SES_RECOVERY_TEST_step0_attempt0',
        attemptCount: 1,
        speedMultiplier: 1,
        variables: {},
        navigationPending: false,
        cancellationRequested: false,
        lastError: 'Outcome uncertain',
        sessionRevision: 1,
        startedAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000,
        eventLog: [],
      };
      await ReplaySessionStorage.saveSession(initialSession);

      const orchestrator = new ReplayOrchestrator();
      // User clicks "Resume Next Step"
      const resumed = await orchestrator.resume('SES_RECOVERY_TEST', { forceAdvance: true });
      expect(resumed).toBe(true);

      const updated = await ReplaySessionStorage.getActiveSession();
      expect(updated?.currentStepIndex).toBe(1);
      expect(updated?.lastCompletedStepIndex).toBe(0);

      await orchestrator.stop();
    });
  });
});
