import { completeSetup, expect, test } from './fixtures/electron';

test.describe('ClawX updates settings', () => {
  test('shows updates as disabled', async ({ page }) => {
    await completeSetup(page);

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-updates-disabled')).toBeVisible();
  });
});
