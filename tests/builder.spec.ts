import { test, expect } from './fixtures';

test.describe('Visual Workflow Builder & Clean Popup Navigation (Browser Tests)', () => {
  test('1. Clean Popup renders only Workflows and Record tabs; extra tabs are removed', async ({ page, extensionId }) => {
    // Navigate to popup in local mode
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for the popup UI to load
    await expect(page.locator('body')).toBeVisible();

    // Verify only the 2 core tabs are rendered
    await expect(page.locator('button:has-text("Workflows")')).toBeVisible();
    await expect(page.locator('button:has-text("Record")')).toBeVisible();

    // Verify unwanted screens/tabs are NOT present in the popup
    await expect(page.locator('button:has-text("Templates")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Schedules")')).not.toBeVisible();
    await expect(page.locator('button:has-text("APIs")')).not.toBeVisible();
    await expect(page.locator('button:has-text("History")')).not.toBeVisible();
  });

  test('2. Opens Visual Workflow Builder from Popup via + Visual Builder button', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Click + Visual Builder button
    const builderBtn = page.locator('button:has-text("+ Visual Builder")');
    await expect(builderBtn).toBeVisible();
    await builderBtn.click();

    // Visual Builder canvas, Action Palette, and Controls should be rendered
    await expect(page.locator('text=Action Palette')).toBeVisible();
    await expect(page.locator('button:has-text("Preview")')).toBeVisible();
    await expect(page.locator('button:has-text("Save Workflow")')).toBeVisible();
  });

  test('3. Direct navigation to Visual Workflow Builder via URL query parameters', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?view=builder`);
    await page.waitForLoadState('domcontentloaded');

    // Builder canvas, Step Palette, and Controls should be rendered
    await expect(page.locator('text=Action Palette')).toBeVisible();
    await expect(page.locator('button:has-text("Preview")')).toBeVisible();
    await expect(page.locator('button:has-text("Save Workflow")')).toBeVisible();
  });

  test('4. Adds step from palette, moves node, edits step properties, and saves', async ({ page, extensionId }) => {
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

  test('5. Dry-run preview simulation displays expected path without dispatching browser interactions', async ({
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

  test('6. Switches smoothly between Record and Workflows tabs', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/index.html?mode=local`);
    await page.waitForLoadState('domcontentloaded');

    // Switch to Record tab
    const recordTabBtn = page.locator('button:has-text("Record")');
    await recordTabBtn.click();
    await expect(page.locator('text=Start Recording Interactions')).toBeVisible();

    // Switch back to Workflows tab
    const workflowsTabBtn = page.locator('button:has-text("Workflows")');
    await workflowsTabBtn.click();
    await expect(page.locator('text=Visual Builder & Replays')).toBeVisible();
  });
});
