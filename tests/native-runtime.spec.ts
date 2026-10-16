import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 393, height: 850 } });
test('native runtime has system text entry and no preview chrome or duplicate keyboard inset', async ({ page }) => {
  await page.goto('/tests/native-runtime-fixture.html');
  await expect(page.locator('.phone-stage,.phone-device,.keyboard-dock,.status-bar,.android-navigation-bar')).toHaveCount(0);
  await page.getByRole('textbox', { name: '姓名', exact: true }).fill('本人手机');
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('本人手机');
  // Hardware keyboard focus does not pretend that a software IME appeared.
  await expect(page.getByTestId('metrics')).toContainText('"keyboard":false');
  await expect(page.getByRole('complementary', { name: '当前记录控制' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oops:native-message', { detail: { type: 'insets', payload: { top: 28, bottom: 24 } } })));
  await expect(page.getByTestId('metrics')).toContainText('"top":28');
  await expect(page.locator('.native-app-viewport')).toHaveCSS('bottom', '24px');
  await page.setViewportSize({ width: 393, height: 520 });
  await expect(page.getByTestId('metrics')).toContainText('"keyboard":true');
  await expect(page.getByTestId('metrics')).toContainText('"bottomInset":0');
  await expect(page.locator('.native-device-screen')).toHaveCSS('height', '520px');
  await expect(page.locator('.native-app-viewport')).toHaveCSS('bottom', '0px');
  await expect(page.getByRole('complementary', { name: '当前记录控制' })).toBeHidden();
  await page.setViewportSize({ width: 393, height: 850 });
  await expect(page.getByTestId('metrics')).toContainText('"keyboard":false');
});

test('native sheet stays inside screen portal, accepts actual text, and consumes system back', async ({ page }) => {
  await page.goto('/tests/native-runtime-fixture.html');
  await page.getByRole('button', { name: '打开面板' }).click();
  await expect(page.locator('.native-device-screen [role="dialog"]')).toBeVisible();
  await page.getByRole('textbox', { name: '面板文字' }).fill('新的确认内容');
  await expect(page.getByRole('textbox', { name: '面板文字' })).toHaveValue('新的确认内容');
  expect(await page.evaluate(() => { const event = new Event('oops:native-back', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
