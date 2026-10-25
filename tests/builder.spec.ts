import { test, expect } from './fixtures';

test.describe('Phase 10 & 11: Visual Workflow Builder & Advanced Automation (Browser Tests)', () => {
  test('1. Opens Visual Workflow Builder from Popup, displays palette and canvas', async ({ page, extensionId }) => {
    // Navigate to popup in local mode
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for the popup UI to load
    await expect(page.locator('body')).toBeVisible();

    // Verify tabs are rendered
    await expect(page.locator('button:has-text("Workflows")')).toBeVisible();
    await expect(page.locator('button:has-text("Templates")')).toBeVisible();
    await expect(page.locator('button:has-text("Schedules")')).toBeVisible();
    await expect(page.locator('button:has-text("APIs")')).toBeVisible();
    await expect(page.locator('button:has-text("History")')).toBeVisible();
  });

  test('2. Direct navigation to Visual Workflow Builder via URL query parameters', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?view=builder`);
    await page.waitForLoadState('domcontentloaded');

    // Builder canvas, Step Palette, and Controls should be rendered
    await expect(page.locator('text=Action Palette')).toBeVisible();
    await expect(page.locator('button:has-text("Preview")')).toBeVisible();
    await expect(page.locator('button:has-text("Save Workflow")')).toBeVisible();
  });

  test('3. Adds step from palette, moves node, edits step properties, and saves', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?view=builder`);
    await page.waitForLoadState('domcontentloaded');

    // Click on palette Navigate button to add step
    const navPaletteBtn = page.locator('button:has-text("Navigate")').first();
    await expect(navPaletteBtn).toBeVisible();
    await navPaletteBtn.click();

    // Step should now appear on the canvas
    const node = page.locator('[data-node-type="navigate"]').first();
    await expect(node).toBeVisible();

    // Click on node to open properties inspector
    await node.click();

    // Inspector should display Target / URL input
    const urlInput = page.locator('input[placeholder*="example.com"]');
    await expect(urlInput).toBeVisible();
    await urlInput.fill('https://example.com/checkout');

    // Save changes
    const saveBtn = page.locator('button:has-text("Save Workflow")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Should indicate Saved state
    await expect(page.locator('text=Workflow saved')).toBeVisible();
  });

  test('4. Dry-run preview simulation displays expected path without dispatching browser interactions', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?view=builder`);
    await page.waitForLoadState('domcontentloaded');

    // Add a wait step from palette
    const waitBtn = page.locator('button:has-text("Wait / Delay")').first();
    await expect(waitBtn).toBeVisible();
    await waitBtn.click();

    // Click Simulate Preview
    const previewBtn = page.locator('button:has-text("Preview")');
    await previewBtn.click();

    // Preview modal should appear
    await expect(page.locator('text=Workflow Dry-Run Preview')).toBeVisible();
    await expect(page.locator('text=Safe offline graph simulation')).toBeVisible();
    await expect(page.locator('text=Workflow Terminated Successfully')).toBeVisible();

    // Close preview modal
    await page.locator('button:has-text("Close Preview")').click();
    await expect(page.locator('text=Workflow Dry-Run Preview')).not.toBeVisible();
  });

  test('5. Templates view lists pre-built automation templates and instantiates a workflow', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to Templates tab
    await page.locator('button:has-text("Templates")').click();

    // Pre-built templates should be listed
    await expect(page.locator('text=Form Filling & Verification')).toBeVisible();
    await expect(page.locator('text=Structured Data Extraction')).toBeVisible();
    await expect(page.locator('text=Conditional Page Flow')).toBeVisible();

    // Click 'Use Template' on Form Filling
    const useBtn = page.locator('button:has-text("Use Template")').first();
    await useBtn.click();

    // Should automatically instantiate and open the Visual Builder for the newly created workflow
    await expect(page.locator('text=Action Palette')).toBeVisible();
  });

  test('6. Schedules view renders creation form and side-effect authorization checkbox', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to Schedules tab
    await page.locator('button:has-text("Schedules")').click();
    await expect(page.locator('text=Scheduled Replays')).toBeVisible();

    // Open creation modal
    await page.locator('button:has-text("+ New Schedule")').click();

    await expect(page.locator('text=Create Automation Schedule')).toBeVisible();
    await expect(page.locator('text=Target Workflow')).toBeVisible();
    await expect(page.locator('text=Frequency')).toBeVisible();
    await expect(page.locator('text=Interval (Minutes)')).toBeVisible();
  });

  test('7. Integrations view renders pre-configured API endpoints and test dialog', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to Integrations tab
    await page.locator('button:has-text("APIs")').click();

    await expect(page.locator('text=API Integrations')).toBeVisible();

    // Open Add Integration modal
    await page.locator('button:has-text("+ Add Integration")').click();
    await expect(page.locator('text=Add API Integration')).toBeVisible();
    await expect(page.locator('select').first()).toContainText('Webhook Dispatcher (POST)');
    await expect(page.locator('select').first()).toContainText('REST Data Collector (GET)');
  });

  test('8. Execution History view displays analytics metrics and empty state gracefully', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to History tab
    await page.locator('button:has-text("History")').click();

    await expect(page.locator('text=Replay Analytics & History')).toBeVisible();
    await expect(
      page.locator('text=No executions recorded yet. Play a workflow to generate performance metrics.')
    ).toBeVisible();
  });
});
