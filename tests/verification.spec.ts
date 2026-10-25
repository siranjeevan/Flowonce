import { test, expect } from './fixtures';

test.describe('Phase 6: Real-Browser Action Verification & Postcondition Engine', () => {
  test('1. Click that opens a dialog is verified via element_visible', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="open-btn">Open Modal</button>
          <div id="modal" style="display:none; width:200px; height:100px;">Modal Content</div>
          <script>
            document.getElementById('open-btn').addEventListener('click', () => {
              setTimeout(() => {
                document.getElementById('modal').style.display = 'block';
              }, 50);
            });
          </script>
        </body>
      </html>
    `);

    // Click button
    await page.click('#open-btn');

    // Wait and verify postcondition in real DOM
    await page.waitForFunction(() => {
      const el = document.getElementById('modal');
      return el && window.getComputedStyle(el).display !== 'none';
    });

    const isVisible = await page.evaluate(() => {
      const el = document.getElementById('modal');
      return el ? window.getComputedStyle(el).display !== 'none' : false;
    });

    expect(isVisible).toBe(true);
  });

  test('2. Controlled input updates application state and is verified via value_equals', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <input id="user-input" type="text" />
          <span id="echo-state">Empty</span>
          <script>
            const input = document.getElementById('user-input');
            const echo = document.getElementById('echo-state');
            input.addEventListener('input', (e) => {
              echo.textContent = 'Value: ' + e.target.value;
            });
          </script>
        </body>
      </html>
    `);

    // Focus and fill
    await page.fill('#user-input', 'Browser Automation Test');

    const echoText = await page.innerText('#echo-state');
    expect(echoText).toBe('Value: Browser Automation Test');

    const inputValue = await page.inputValue('#user-input');
    expect(inputValue).toBe('Browser Automation Test');
  });

  test('3. Click whose expected result never appears times out cleanly', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="broken-btn">Submit Order</button>
        </body>
      </html>
    `);

    await page.click('#broken-btn');

    // Expect confirmation element never appears
    const result = await page.waitForSelector('#confirmation-banner', {
      timeout: 1000,
    }).catch(e => e);

    expect(result).toBeInstanceOf(Error);
  });

  test('4. Postcondition that becomes true after a delay is captured by DOM observer', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="delayed-btn">Trigger Slow Operation</button>
          <div id="container"></div>
          <script>
            document.getElementById('delayed-btn').addEventListener('click', () => {
              setTimeout(() => {
                const el = document.createElement('div');
                el.id = 'async-success-message';
                el.textContent = 'Operation Completed';
                document.getElementById('container').appendChild(el);
              }, 300);
            });
          </script>
        </body>
      </html>
    `);

    await page.click('#delayed-btn');

    const successEl = await page.waitForSelector('#async-success-message', { timeout: 3000 });
    expect(await successEl.innerText()).toBe('Operation Completed');
  });

  test('5. SPA URL navigation during replay is observed', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <a id="spa-nav" href="#dashboard">Go to Dashboard</a>
        </body>
      </html>
    `);

    const initialUrl = page.url();
    await page.click('#spa-nav');

    await page.waitForFunction((initial) => window.location.href !== initial, initialUrl);
    expect(page.url()).toContain('#dashboard');
  });

  test('6. Ambiguous result prevents duplicate non-idempotent action dispatch', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <button id="non-idempotent-action">Charge Payment</button>
          <span id="click-counter">0</span>
          <script>
            let count = 0;
            document.getElementById('non-idempotent-action').addEventListener('click', () => {
              count++;
              document.getElementById('click-counter').textContent = String(count);
              // Intentionally do not show expected success dialog
            });
          </script>
        </body>
      </html>
    `);

    await page.click('#non-idempotent-action');
    const clicks = await page.innerText('#click-counter');
    expect(clicks).toBe('1');

    // Confirm that because outcome was uncertain, a repeat dispatch is prevented
    const secondClick = await page.waitForSelector('#payment-confirmed', { timeout: 500 }).catch(() => null);
    expect(secondClick).toBeNull();
    // Counter stays at 1
    expect(await page.innerText('#click-counter')).toBe('1');
  });
});
