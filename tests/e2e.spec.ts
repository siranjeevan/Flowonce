import { test, expect } from './fixtures';

test('FlowOnce Core E2E Flow', async ({ page, extensionId }) => {
  // We cannot easily test Google Auth or Firebase Auth inside a playwright test without 
  // extensive mocking or dummy credentials.
  
  // Navigate to popup
  const popupUrl = `chrome-extension://${extensionId}/index.html`;
  
  await page.goto(popupUrl);
  
  // We expect to see the FlowOnce header
  await expect(page.locator('h1')).toHaveText('FlowOnce');

  // Verify that we need to log in
  // Instead of full E2E, this test verifies the extension loads successfully
  // and renders without crashing
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).toContain('FlowOnce');
});
