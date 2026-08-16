import { expect, test } from '@playwright/test';

test('React Router keeps navigation and deep reloads under /feelmyrythm', async ({ page }) => {
  await page.goto('/feelmyrythm/');

  await expect(page).toHaveURL(/\/feelmyrythm\/$/);
  await expect(page).toHaveTitle('메트로놈 · FeelMyRythm');
  await expect(page.getByText('개인 연습', { exact: true })).toBeVisible();

  const editorLink = page.getByRole('link', { name: '템포맵', exact: true }).first();
  await expect(editorLink).toHaveAttribute('href', '/feelmyrythm/editor');
  await editorLink.click();
  await expect(page).toHaveURL(/\/feelmyrythm\/editor$/);
  await expect(page.getByRole('heading', { name: '템포맵 편집기' })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/feelmyrythm\/editor$/);
  await expect(page.getByRole('heading', { name: '템포맵 편집기' })).toBeVisible();
});
