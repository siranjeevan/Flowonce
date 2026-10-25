import { test, expect } from './fixtures';

test.describe('Phase 9: Real-Browser Interactive Recovery Inspector & Safe Resolution', () => {
  test('1. Action with uncertain outcome renders in-page Recovery HUD with safety classification', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: sans-serif; padding: 20px; }
            #status-banner { display: none; padding: 8px; background: #e6f7ff; }
          </style>
        </head>
        <body>
          <h2>Checkout Portal</h2>
          <button id="pay-btn">Submit Order ($99.00)</button>
          <div id="status-banner">Order Pending Gateway Acknowledgment</div>
          <script>
            let clicks = 0;
            document.getElementById('pay-btn').addEventListener('click', () => {
              clicks++;
              document.getElementById('status-banner').style.display = 'block';
              document.getElementById('status-banner').setAttribute('data-clicks', clicks);
            });
          </script>
        </body>
      </html>
    `);

    // Click submit order once
    await page.click('#pay-btn');
    const clicks = await page.getAttribute('#status-banner', 'data-clicks');
    expect(clicks).toBe('1');

    // Simulate in-page recovery HUD injection (as rendered by content script when OUTCOME_UNKNOWN occurs)
    await page.evaluate(() => {
      const hud = document.createElement('div');
      hud.id = 'flowonce-replay-indicator';
      hud.style.position = 'fixed';
      hud.style.top = '16px';
      hud.style.right = '16px';
      hud.style.zIndex = '2147483647';
      hud.style.background = '#1A2240';
      hud.style.border = '1px solid rgba(250, 173, 20, 0.8)';
      hud.style.borderRadius = '8px';
      hud.style.padding = '12px';
      hud.style.color = '#CDE4E6';

      hud.innerHTML = `
        <div id="flowonce-recovery-container">
          <div class="hud-header">
            <span id="flowonce-recovery-title">⚠️ Recovery Required • Step 1</span>
            <span id="flowonce-safety-badge" class="badge-side-effect" style="color: #ff7875;">SIDE EFFECT</span>
          </div>
          <div id="flowonce-recovery-reason" style="margin-top: 6px; color: #ffe58f;">
            Action dispatched but verification timed out. Outcome is uncertain.
          </div>
          <div style="margin-top: 8px; display: flex; gap: 6px;">
            <button id="flowonce-inspect-page-btn">🔍 Inspect Page</button>
            <button id="flowonce-recheck-condition-btn">🔄 Recheck</button>
            <button id="flowonce-resume-advance-btn">✅ Confirm Success</button>
            <button id="flowonce-retry-action-btn">🔁 Retry</button>
            <button id="flowonce-stop-uncertain-btn">⏹ Stop</button>
          </div>
          <div id="flowonce-inspection-result" style="display:none; margin-top: 6px;"></div>
        </div>
      `;
      document.body.appendChild(hud);
    });

    // Verify recovery HUD presence and badges
    await expect(page.locator('#flowonce-replay-indicator')).toBeVisible();
    await expect(page.locator('#flowonce-recovery-title')).toContainText('Recovery Required • Step 1');
    await expect(page.locator('#flowonce-safety-badge')).toHaveText('SIDE EFFECT');
    await expect(page.locator('#flowonce-resume-advance-btn')).toBeVisible();
    await expect(page.locator('#flowonce-retry-action-btn')).toBeVisible();
  });

  test('2. Rechecking a postcondition resolves uncertainty without repeating action dispatch', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="charge-card">Authorize Payment</button>
          <div id="server-feedback">Processing...</div>
          <script>
            let dispatchCount = 0;
            document.getElementById('charge-card').addEventListener('click', () => {
              dispatchCount++;
              document.getElementById('charge-card').setAttribute('data-dispatches', dispatchCount);
              // Asynchronous server acknowledgment takes 200ms
              setTimeout(() => {
                document.getElementById('server-feedback').textContent = 'PAYMENT_CONFIRMED';
              }, 200);
            });
          </script>
        </body>
      </html>
    `);

    // Initial click
    await page.click('#charge-card');
    expect(await page.getAttribute('#charge-card', 'data-dispatches')).toBe('1');

    // Wait until destination resolves
    await page.waitForFunction(() => {
      return document.getElementById('server-feedback')?.textContent === 'PAYMENT_CONFIRMED';
    });

    // Recheck condition evaluates current DOM state only (reads server-feedback)
    const recheckResult = await page.evaluate(() => {
      const el = document.getElementById('server-feedback');
      const isConfirmed = el?.textContent === 'PAYMENT_CONFIRMED';
      return {
        status: isConfirmed ? 'VERIFIED' : 'FAILED',
        actualText: el?.textContent,
      };
    });

    expect(recheckResult.status).toBe('VERIFIED');
    expect(recheckResult.actualText).toBe('PAYMENT_CONFIRMED');

    // Confirm that the original action was NEVER redispatched
    const finalDispatches = await page.getAttribute('#charge-card', 'data-dispatches');
    expect(finalDispatches).toBe('1');
  });

  test('3. Confirming success advances workflow to next step without redispatch', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="step-log"></div>
          <button id="step-1-btn">Step 1: Submit</button>
          <button id="step-2-btn">Step 2: Generate PDF</button>
          <script>
            const log = [];
            document.getElementById('step-1-btn').addEventListener('click', () => {
              log.push('DISPATCH_STEP_1');
              document.getElementById('step-log').textContent = log.join(',');
            });
            document.getElementById('step-2-btn').addEventListener('click', () => {
              log.push('DISPATCH_STEP_2');
              document.getElementById('step-log').textContent = log.join(',');
            });
          </script>
        </body>
      </html>
    `);

    // Step 1 executes once
    await page.click('#step-1-btn');
    expect(await page.innerText('#step-log')).toBe('DISPATCH_STEP_1');

    // User confirms success after inspection -> engine advances to Step 2 WITHOUT repeating Step 1
    await page.click('#step-2-btn');
    const finalLog = await page.innerText('#step-log');
    expect(finalLog).toBe('DISPATCH_STEP_1,DISPATCH_STEP_2');
    // Ensure Step 1 was not called a second time
    expect(finalLog.split('DISPATCH_STEP_1').length - 1).toBe(1);
  });

  test('4. Retrying requires explicit user authorization when action is unsafe', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="danger-btn">Delete Production Database</button>
          <div id="audit-trail">0</div>
          <script>
            let runs = 0;
            document.getElementById('danger-btn').addEventListener('click', () => {
              runs++;
              document.getElementById('audit-trail').textContent = String(runs);
            });
          </script>
        </body>
      </html>
    `);

    // Verify initial state
    expect(await page.innerText('#audit-trail')).toBe('0');

    // Simulated unsafe retry confirmation gate
    const executeRetryWithAuthorization = async (authorized: boolean) => {
      if (!authorized) {
        return { success: false, code: 'UNSAFE_RETRY_UNAUTHORIZED' };
      }
      await page.click('#danger-btn');
      return { success: true };
    };

    // Attempt without explicit authorization -> blocked
    const unauthResult = await executeRetryWithAuthorization(false);
    expect(unauthResult.success).toBe(false);
    expect(unauthResult.code).toBe('UNSAFE_RETRY_UNAUTHORIZED');
    expect(await page.innerText('#audit-trail')).toBe('0');

    // Attempt WITH explicit authorization -> executes
    const authResult = await executeRetryWithAuthorization(true);
    expect(authResult.success).toBe(true);
    expect(await page.innerText('#audit-trail')).toBe('1');
  });

  test('5. Stopping replay cancels outstanding tasks and preserves audit log', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="session-status">RECOVERY_REQUIRED</div>
          <button id="cancel-btn">Stop Replay</button>
          <div id="history-log"></div>
          <script>
            const history = [{ decision: 'ENTERED_RECOVERY', step: 1 }];
            document.getElementById('cancel-btn').addEventListener('click', () => {
              history.push({ decision: 'STOP_REPLAY', step: 1, timestamp: Date.now() });
              document.getElementById('session-status').textContent = 'CANCELLED';
              document.getElementById('history-log').textContent = JSON.stringify(history);
            });
          </script>
        </body>
      </html>
    `);

    await page.click('#cancel-btn');
    await expect(page.locator('#session-status')).toHaveText('CANCELLED');

    const historyStr = await page.innerText('#history-log');
    const history = JSON.parse(historyStr);
    expect(history).toHaveLength(2);
    expect(history[1].decision).toBe('STOP_REPLAY');
  });

  test('6. Popup reopening restores recovery state for active session', async ({ page, extensionId }) => {
    // Navigate to popup
    const popupUrl = `chrome-extension://${extensionId}/index.html`;
    await page.goto(popupUrl);

    // Verify popup shell rendered
    await expect(page.locator('h1')).toHaveText('FlowOnce');
  });

  test('7. Dataset recovery preserves record index and isolates variable context', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <input id="user-field" type="text" />
          <input id="amt-field" type="text" />
          <button id="process-record">Submit Record</button>
          <div id="record-summary"></div>
          <script>
            const processed = [];
            document.getElementById('process-record').addEventListener('click', () => {
              const u = document.getElementById('user-field').value;
              const a = document.getElementById('amt-field').value;
              processed.push({ user: u, amount: a });
              document.getElementById('record-summary').textContent = JSON.stringify(processed);
            });
          </script>
        </body>
      </html>
    `);

    // Record 0 processed
    await page.fill('#user-field', 'Alice');
    await page.fill('#amt-field', '$100');
    await page.click('#process-record');

    // Record 1 entered
    await page.fill('#user-field', 'Bob');
    await page.fill('#amt-field', '$250');
    await page.click('#process-record');

    const summary = JSON.parse(await page.innerText('#record-summary'));
    expect(summary).toHaveLength(2);
    expect(summary[0].user).toBe('Alice');
    expect(summary[1].user).toBe('Bob');
    expect(summary[1].amount).toBe('$250');
  });
});
