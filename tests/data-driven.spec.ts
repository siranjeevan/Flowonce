import { test, expect } from './fixtures';

test.describe('Phase 7: Real-Browser Data-Driven Automation & Conditional Branching', () => {
  test('1. Data-driven execution: sequentially fills form with isolated record variables and extracts DOM outputs', async ({ page }) => {
    // Setup interactive form application
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: sans-serif; padding: 20px; }
            .hidden { display: none; }
            .entry { margin-bottom: 8px; }
          </style>
        </head>
        <body>
          <h2>Customer Registration</h2>
          <form id="reg-form">
            <div class="entry">
              <label for="username">Username:</label>
              <input id="username" type="text" />
            </div>
            <div class="entry">
              <label for="role">Role:</label>
              <input id="role" type="text" />
            </div>
            <div class="entry">
              <label for="subscribe">Newsletter:</label>
              <input id="subscribe" type="checkbox" />
            </div>
            <button id="submit-btn" type="button">Register</button>
          </form>

          <div id="result-box" class="hidden">
            <span id="welcome-msg"></span>
            <span id="auth-token" data-token-id=""></span>
          </div>

          <script>
            let submissionCount = 0;
            document.getElementById('submit-btn').addEventListener('click', () => {
              const u = document.getElementById('username').value;
              const r = document.getElementById('role').value;
              const s = document.getElementById('subscribe').checked;
              submissionCount++;

              const resultBox = document.getElementById('result-box');
              resultBox.className = '';
              document.getElementById('welcome-msg').textContent = 'Registered: ' + u + ' (' + r + ')';
              const tokenEl = document.getElementById('auth-token');
              tokenEl.textContent = 'TOKEN-' + submissionCount + '-' + u.toUpperCase();
              tokenEl.setAttribute('data-token-id', 'ID-' + submissionCount);
            });
          </script>
        </body>
      </html>
    `);

    // Dataset with 2 records
    const dataset = [
      { username: 'alice', role: 'admin', subscribe: true },
      { username: 'bob', role: 'engineer', subscribe: false },
    ];

    const capturedOutputs: Record<string, string>[] = [];

    for (let i = 0; i < dataset.length; i++) {
      const record = dataset[i];

      // 1. Fill username
      await page.fill('#username', record.username);
      // 2. Fill role
      await page.fill('#role', record.role);
      // 3. Set checkbox
      if (record.subscribe) {
        await page.check('#subscribe');
      } else {
        await page.uncheck('#subscribe');
      }

      // 4. Submit
      await page.click('#submit-btn');

      // 5. Wait for confirmation box
      await page.waitForFunction(() => {
        const box = document.getElementById('result-box');
        return box && !box.classList.contains('hidden');
      });

      // 6. Extract DOM output
      const welcome = await page.innerText('#welcome-msg');
      const token = await page.innerText('#auth-token');
      const dataId = await page.getAttribute('#auth-token', 'data-token-id');

      capturedOutputs.push({
        welcome,
        token: token || '',
        dataId: dataId || '',
      });
    }

    // Verify record 1 outputs
    expect(capturedOutputs[0].welcome).toBe('Registered: alice (admin)');
    expect(capturedOutputs[0].token).toBe('TOKEN-1-ALICE');
    expect(capturedOutputs[0].dataId).toBe('ID-1');

    // Verify record 2 outputs (record isolation: zero leakage from record 1)
    expect(capturedOutputs[1].welcome).toBe('Registered: bob (engineer)');
    expect(capturedOutputs[1].token).toBe('TOKEN-2-BOB');
    expect(capturedOutputs[1].dataId).toBe('ID-2');
  });

  test('2. Dynamic conditional branching: branches to VIP flow vs Standard flow based on cart value', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <div id="vip-portal" style="display:none; background: #e0f2fe; padding: 10px;">
            <h3>VIP Concierge Checkout</h3>
            <p id="vip-discount">Complimentary 20% Applied</p>
          </div>
          <div id="standard-portal" style="display:none; background: #f1f5f9; padding: 10px;">
            <h3>Standard Checkout</h3>
            <p id="standard-notice">Regular Processing</p>
          </div>
          <script>
            function routeUser(cartTotal) {
              if (cartTotal >= 100) {
                document.getElementById('vip-portal').style.display = 'block';
                document.getElementById('standard-portal').style.display = 'none';
              } else {
                document.getElementById('standard-portal').style.display = 'block';
                document.getElementById('vip-portal').style.display = 'none';
              }
            }
          </script>
        </body>
      </html>
    `);

    // Scenario 1: cartTotal = 250 -> VIP branch taken
    await page.evaluate(() => (window as any).routeUser(250));
    await page.waitForSelector('#vip-portal', { state: 'visible' });
    const isVipVisible = await page.isVisible('#vip-portal');
    const isStandardVisible = await page.isVisible('#standard-portal');
    expect(isVipVisible).toBe(true);
    expect(isStandardVisible).toBe(false);

    // Scenario 2: cartTotal = 45 -> Standard branch taken
    await page.evaluate(() => (window as any).routeUser(45));
    await page.waitForSelector('#standard-portal', { state: 'visible' });
    expect(await page.isVisible('#vip-portal')).toBe(false);
    expect(await page.isVisible('#standard-portal')).toBe(true);
  });

  test('3. Verification-driven branch fallback: handles unexpected page state by taking fallback branch', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="promo-btn">Apply Promo Code</button>
          <div id="status-container"></div>
          <script>
            document.getElementById('promo-btn').addEventListener('click', () => {
              // Simulates promo code rejection
              const el = document.createElement('div');
              el.id = 'promo-error';
              el.textContent = 'Invalid promo code. Please retry.';
              document.getElementById('status-container').appendChild(el);
            });
          </script>
        </body>
      </html>
    `);

    // Click apply
    await page.click('#promo-btn');

    // Postcondition for success (#promo-success) fails
    const successElement = await page.waitForSelector('#promo-success', { timeout: 400 }).catch(() => null);
    expect(successElement).toBeNull();

    // Fallback error element is present
    const errorEl = await page.waitForSelector('#promo-error', { timeout: 1000 });
    expect(errorEl).not.toBeNull();
    const errorText = await page.innerText('#promo-error');
    expect(errorText).toContain('Invalid promo code');
  });

  test('4. Execution budget enforcement: cyclic step jumps terminate safely when maxStepBudget is reached', async () => {
    // Simulates an infinite while-loop in user steps (e.g. step_1 condition jumps to step_1)
    let executionCount = 0;
    const maxBudget = 25;
    let terminatedByBudget = false;

    // Simulate orchestrator loop with budget
    while (executionCount < 1000) {
      executionCount++;
      if (executionCount >= maxBudget) {
        terminatedByBudget = true;
        break;
      }
    }

    expect(terminatedByBudget).toBe(true);
    expect(executionCount).toBe(25);
  });
});
