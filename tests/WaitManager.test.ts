import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WaitManager } from '../src/replay/WaitManager';
import { ActionExecutor } from '../src/replay/ActionExecutor';
import { WaitError } from '../src/replay/timeout-config';
import type { TargetDescriptor, WorkflowStep } from '../src/shared/types/workflow';

describe('Phase 3: Centralized WaitManager & Dynamic Synchronization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('Core Condition-Based Synchronization', () => {
    it('1. Element already exists: returns immediately without unnecessary delay', async () => {
      const btn = document.createElement('button');
      btn.id = 'instant-btn';
      btn.textContent = 'Click me';
      document.body.appendChild(btn);

      const start = Date.now();
      const el = await WaitManager.waitForElement({ id: 'instant-btn', text: 'Click me' }, { timeoutMs: 2000 });
      const elapsed = Date.now() - start;

      expect(el).toBe(btn);
      expect(elapsed).toBeLessThan(100);
    });

    it('2. Element appears after a delay: detects dynamically added DOM node via MutationObserver', async () => {
      setTimeout(() => {
        const delayedBtn = document.createElement('button');
        delayedBtn.id = 'delayed-btn';
        delayedBtn.textContent = 'Appeared!';
        document.body.appendChild(delayedBtn);
      }, 50);

      const el = await WaitManager.waitForElement(
        { id: 'delayed-btn', text: 'Appeared!' },
        { timeoutMs: 1500, pollIntervalMs: 20 }
      );

      expect(el).toBeTruthy();
      expect(el.id).toBe('delayed-btn');
    });

    it('3. Element becomes visible after a DOM change', async () => {
      const hiddenDiv = document.createElement('div');
      hiddenDiv.id = 'visibility-target';
      hiddenDiv.style.display = 'none';
      hiddenDiv.textContent = 'Now you see me';
      document.body.appendChild(hiddenDiv);

      expect(WaitManager.isElementVisible(hiddenDiv)).toBe(false);

      setTimeout(() => {
        hiddenDiv.style.display = 'block';
      }, 50);

      const visibleEl = await WaitManager.waitForVisible(hiddenDiv, { timeoutMs: 1500, pollIntervalMs: 20 });
      expect(visibleEl).toBe(hiddenDiv);
    });

    it('4. Element becomes enabled after a DOM change', async () => {
      const submitBtn = document.createElement('button');
      submitBtn.id = 'submit-btn';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submit';
      document.body.appendChild(submitBtn);

      expect(WaitManager.isElementEnabled(submitBtn)).toBe(false);

      setTimeout(() => {
        submitBtn.removeAttribute('disabled');
        submitBtn.disabled = false;
      }, 50);

      const enabledEl = await WaitManager.waitForEnabled(submitBtn, { timeoutMs: 1500, pollIntervalMs: 20 });
      expect(enabledEl).toBe(submitBtn);
      expect(WaitManager.isElementEnabled(enabledEl)).toBe(true);
    });

    it('5. Element disappears: resolves when target node is removed or hidden', async () => {
      const modal = document.createElement('div');
      modal.id = 'loading-spinner';
      modal.textContent = 'Loading...';
      document.body.appendChild(modal);

      setTimeout(() => {
        modal.remove();
      }, 50);

      const disappeared = await WaitManager.waitForElementToDisappear(modal, { timeoutMs: 1500, pollIntervalMs: 20 });
      expect(disappeared).toBe(true);
    });

    it('6. Text appears: resolves when text content updates dynamically', async () => {
      const statusSpan = document.createElement('span');
      statusSpan.id = 'status';
      statusSpan.textContent = 'Pending...';
      document.body.appendChild(statusSpan);

      setTimeout(() => {
        statusSpan.textContent = 'Completed Successfully';
      }, 50);

      const textAppeared = await WaitManager.waitForText(statusSpan, 'Completed Successfully', {
        timeoutMs: 1500,
        pollIntervalMs: 20,
      });
      expect(textAppeared).toBe(true);
    });

    it('7. Condition timeout: throws structured WAIT_TIMEOUT error with diagnostics', async () => {
      let caughtError: WaitError | null = null;

      try {
        await WaitManager.waitForCondition(() => false, {
          timeoutMs: 80,
          pollIntervalMs: 20,
          message: 'waitForCustomCondition',
        });
      } catch (err) {
        if (err instanceof WaitError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError?.code).toBe('WAIT_TIMEOUT');
      expect(caughtError?.diagnostics.status).toBe('timeout');
      expect(caughtError?.diagnostics.condition).toBe('waitForCustomCondition');
      expect(caughtError?.diagnostics.elapsedMs).toBeGreaterThanOrEqual(70);
    });

    it('8. Cancellation before completion: rejects immediately with WAIT_CANCELLED', async () => {
      const controller = new AbortController();
      controller.abort(); // already aborted

      await expect(
        WaitManager.waitForCondition(() => false, {
          timeoutMs: 5000,
          signal: controller.signal,
          message: 'already aborted',
        })
      ).rejects.toThrowError(WaitError);

      try {
        await WaitManager.waitForCondition(() => false, {
          timeoutMs: 5000,
          signal: controller.signal,
        });
      } catch (err: any) {
        expect(err.code).toBe('WAIT_CANCELLED');
        expect(err.diagnostics.status).toBe('cancelled');
      }
    });

    it('9. Cancellation after observer registration: cleans up immediately upon abort signal', async () => {
      const controller = new AbortController();

      setTimeout(() => {
        controller.abort();
      }, 50);

      let caughtError: WaitError | null = null;
      try {
        await WaitManager.waitForElement(
          { id: 'never-appears' },
          { timeoutMs: 5000, signal: controller.signal, pollIntervalMs: 20 }
        );
      } catch (err) {
        if (err instanceof WaitError) caughtError = err;
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError?.code).toBe('WAIT_CANCELLED');
      expect(caughtError?.diagnostics.elapsedMs).toBeLessThan(1000);
    });

    it('10. Observer and timer cleanup: cleans up all observers and listeners on resolution', async () => {
      const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');

      const target = document.createElement('div');
      target.id = 'cleanup-target';
      document.body.appendChild(target);

      await WaitManager.waitForElement({ id: 'cleanup-target' }, { timeoutMs: 1000 });

      // If condition was immediately satisfied, observer was never even registered
      // Now test with a delayed condition that does register observer:
      setTimeout(() => {
        const delayed = document.createElement('span');
        delayed.id = 'delayed-cleanup';
        document.body.appendChild(delayed);
      }, 30);

      await WaitManager.waitForElement({ id: 'delayed-cleanup' }, { timeoutMs: 1000, pollIntervalMs: 15 });

      expect(disconnectSpy).toHaveBeenCalled();
      disconnectSpy.mockRestore();
    });

    it('11. Target replacement during waiting: handles DOM replacement gracefully', async () => {
      const oldElement = document.createElement('button');
      oldElement.id = 're-render-btn';
      oldElement.textContent = 'Rendering...';
      oldElement.disabled = true; // Not interactable yet
      document.body.appendChild(oldElement);

      // Simulate a React re-render or component unmount/remount
      setTimeout(() => {
        oldElement.remove();
        const newElement = document.createElement('button');
        newElement.id = 're-render-btn';
        newElement.textContent = 'Fresh Element';
        newElement.disabled = false;
        document.body.appendChild(newElement);
      }, 40);

      const resolved = await WaitManager.waitForInteractable(
        { id: 're-render-btn', text: 'Fresh Element' },
        'click',
        { timeoutMs: 1500, pollIntervalMs: 15 }
      );

      expect(resolved.isConnected).toBe(true);
      expect(resolved.textContent).toBe('Fresh Element');
      expect(resolved).not.toBe(oldElement);
    });

    it('12. Ambiguous target detection: reports TARGET_AMBIGUOUS when multiple tied candidates match', async () => {
      document.body.innerHTML = `
        <div class="card"><button class="btn">Delete</button></div>
        <div class="card"><button class="btn">Delete</button></div>
      `;

      const descriptor: TargetDescriptor = {
        tag: 'button',
        text: 'Delete',
      };

      let caughtError: WaitError | null = null;
      try {
        await WaitManager.waitForElement(descriptor, { timeoutMs: 1000 });
      } catch (err) {
        if (err instanceof WaitError) caughtError = err;
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError?.code).toBe('TARGET_AMBIGUOUS');
    });

    it('13. Invalid selector handling: handles invalid CSS selector gracefully without unhandled crashes', async () => {
      const descriptor: TargetDescriptor = {
        tag: 'div',
        selector: ':::invalid#css[selector%%%',
      };

      let caughtError: WaitError | null = null;
      try {
        await WaitManager.waitForElement(descriptor, { timeoutMs: 80, pollIntervalMs: 20 });
      } catch (err) {
        if (err instanceof WaitError) caughtError = err;
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError?.code).toBe('WAIT_TIMEOUT');
    });

    it('14. Multiple concurrent waits execute independently without interference', async () => {
      const p1 = WaitManager.waitForCondition(
        () => {
          return document.getElementById('target-1');
        },
        { timeoutMs: 1000, pollIntervalMs: 20 }
      );

      const p2 = WaitManager.waitForCondition(
        () => {
          return document.getElementById('target-2');
        },
        { timeoutMs: 1000, pollIntervalMs: 20 }
      );

      setTimeout(() => {
        const el1 = document.createElement('div');
        el1.id = 'target-1';
        document.body.appendChild(el1);
      }, 30);

      setTimeout(() => {
        const el2 = document.createElement('div');
        el2.id = 'target-2';
        document.body.appendChild(el2);
      }, 60);

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.id).toBe('target-1');
      expect(res2.id).toBe('target-2');
    });

    it('15. Cancellation isolation: cancelling one session does not affect another', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const wait1 = WaitManager.waitForCondition(() => false, {
        timeoutMs: 1000,
        signal: controller1.signal,
        sessionId: 'SES_1',
      });

      const wait2 = WaitManager.waitForCondition(
        () => {
          const el = document.getElementById('ses2-el');
          return el ? true : null;
        },
        {
          timeoutMs: 1000,
          signal: controller2.signal,
          sessionId: 'SES_2',
          pollIntervalMs: 20,
        }
      );

      // Cancel only session 1
      controller1.abort();

      setTimeout(() => {
        const el = document.createElement('div');
        el.id = 'ses2-el';
        document.body.appendChild(el);
      }, 40);

      await expect(wait1).rejects.toThrowError(WaitError);

      const res2 = await wait2;
      expect(res2).toBe(true);
    });
  });

  describe('Integration with TargetResolver and ActionExecutor', () => {
    it('waitForInteractable verifies clickability preconditions before returning', async () => {
      const btn = document.createElement('button');
      btn.id = 'interact-btn';
      btn.textContent = 'Save Project';
      btn.disabled = true; // start disabled
      document.body.appendChild(btn);

      setTimeout(() => {
        btn.disabled = false;
      }, 40);

      const interactable = await WaitManager.waitForInteractable(
        { id: 'interact-btn', text: 'Save Project' },
        'click',
        { timeoutMs: 1500, pollIntervalMs: 20 }
      );

      expect(interactable).toBe(btn);
      expect(btn.disabled).toBe(false);
    });

    it('ActionExecutor executes click action with dynamic waiting and dispatches events', async () => {
      const clickTarget = document.createElement('button');
      clickTarget.id = 'submit-action';
      clickTarget.textContent = 'Submit Form';
      document.body.appendChild(clickTarget);

      let clickFired = false;
      clickTarget.addEventListener('click', () => {
        clickFired = true;
      });

      const step: WorkflowStep = {
        id: 'step_click',
        type: 'click',
        timestamp: 100,
        url: 'https://test.com',
        sequence: 1,
        target: {
          id: 'submit-action',
          tag: 'button',
          text: 'Submit Form',
        },
      };

      const success = await ActionExecutor.execute(step);
      expect(success).toBe(true);
      expect(clickFired).toBe(true);
    });

    it('ActionExecutor executes input action with reactive event dispatching', async () => {
      const inputEl = document.createElement('input');
      inputEl.id = 'username-input';
      document.body.appendChild(inputEl);

      let inputFired = false;
      inputEl.addEventListener('input', () => {
        inputFired = true;
      });

      const step: WorkflowStep = {
        id: 'step_input',
        type: 'input',
        timestamp: 200,
        url: 'https://test.com',
        sequence: 2,
        value: 'automation_user',
        target: {
          id: 'username-input',
          tag: 'input',
        },
      };

      const success = await ActionExecutor.execute(step);
      expect(success).toBe(true);
      expect(inputEl.value).toBe('automation_user');
      expect(inputFired).toBe(true);
    });

    it('ActionExecutor handles explicit wait steps cancellably', async () => {
      const step: WorkflowStep = {
        id: 'step_wait',
        type: 'wait',
        timestamp: 300,
        url: 'https://test.com',
        sequence: 3,
        value: '50', // 50ms wait
      };

      const start = Date.now();
      const success = await ActionExecutor.execute(step);
      expect(success).toBe(true);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);

      // Test with abort signal
      const controller = new AbortController();
      controller.abort();
      await expect(ActionExecutor.execute(step, 1, { signal: controller.signal })).rejects.toThrowError(WaitError);
    });

    it('waitForUrlChange detects SPA URL changes accurately', async () => {
      const initialUrl = window.location.href;

      setTimeout(() => {
        history.pushState({}, '', '/dashboard/settings');
      }, 40);

      const newUrl = await WaitManager.waitForUrlChange(initialUrl, { timeoutMs: 1500, pollIntervalMs: 20 });
      expect(newUrl).toContain('/dashboard/settings');
    });
  });
});
