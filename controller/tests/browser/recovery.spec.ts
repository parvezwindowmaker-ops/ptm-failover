import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('claim, setup, persisted monitoring, reviewed failover and incident timeline', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Bootstrap token')
    .fill(readFileSync(join(process.env.PTM_E2E_DIR!, 'bootstrap-token'), 'utf8'));
  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Application' }).first().click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Installation location').fill('Independent test host');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Application name').fill('Demo API');
  await page.getByLabel('Public hostname').fill('api.demo.local');
  await page.getByLabel('Desired release').fill('v1');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two prepared demo origins' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Save policy' }).click();
  for (const name of [
    'Durable database',
    'Compatible sessions / authentication',
    'Durable uploads',
    'TLS configured on both origins',
    'Image / release parity',
    'Backup capacity',
  ])
    await page.getByLabel(name, { exact: false }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Run read-only preflight' }).click();
  await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Finish with automation paused' }).click();
  await expect(page.getByRole('heading', { name: 'Demo API', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Receiving traffic', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Simulate primary failure' }).click();
  await page.getByRole('button', { name: 'Fail Over', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review failover' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm traffic change' }).click();
  await expect(page.getByText('Active backup', { exact: true })).toBeVisible({ timeout: 45000 });
  await page.getByRole('link', { name: 'Incidents', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect' }).first().click();
  await expect(page.getByRole('heading', { name: 'Incident timeline' })).toBeVisible();
  await expect(page.getByText('Public route returned expected identity and release')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});
