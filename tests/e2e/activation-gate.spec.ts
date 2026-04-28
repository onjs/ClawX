import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('ClawX activation gate', () => {
  test('shows activation page on a fresh profile before setup', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ enableActivationGate: true });

    try {
      const page = await getStableWindow(app);
      await expect(page.getByTestId('activation-page')).toBeVisible();
      await expect(page.getByTestId('setup-page')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
