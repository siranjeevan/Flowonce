import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(process.cwd(), 'dist');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowonce-playwright-'));

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  },
  extensionId: async ({ context }, use) => {
    // for manifest v3:
    let [background] = context.serviceWorkers();
    if (!background) {
      try {
        background = await context.waitForEvent('serviceworker', { timeout: 8000 });
      } catch {
        // Fallback: check existing service workers or background pages
        const workers = context.serviceWorkers();
        if (workers.length > 0) {
          background = workers[0];
        }
      }
    }

    if (!background) {
      throw new Error('Could not locate extension background service worker');
    }

    const extensionId = background.url().split('/')[2];
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(extensionId);
  },
});
export const expect = test.expect;
