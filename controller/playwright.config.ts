import { defineConfig } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('data', { recursive: true });
const testData = process.env.PTM_E2E_DIR ?? mkdtempSync(resolve('data/e2e-'));
process.env.PTM_E2E_DIR = testData;
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://localhost:8080', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://localhost:8080/api/v1/health/ready',
    reuseExistingServer: false,
    timeout: 60000,
    env: { PTM_E2E_DIR: testData },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
