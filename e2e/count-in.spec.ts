import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 390, height: 844, scale: 1 },
  { width: 568, height: 320, scale: 1 },
  { width: 390, height: 844, scale: 2 },
  { width: 256, height: 640, scale: 2 },
  { width: 1280, height: 800, scale: 1 },
]) {
  test(`count-in popup fits ${viewport.width}×${viewport.height} at ${viewport.scale * 100}% text and keeps stop available`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('fmr.countInEnabled', 'true');
      localStorage.setItem('fmr.countInMeasures', '2');
    });
    await page.goto('/feelmyrythm/');
    if (viewport.scale === 2) {
      await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    }
    const start = page.getByRole('button', { name: '메트로놈 재생', exact: true });
    await start.click();
    const popup = page.locator('.fmr-count-in');
    await expect(popup).toHaveCount(1);
    await expect(popup.locator('.fmr-count-in__value')).toHaveText('3');
    await expect(popup.locator('.fmr-count-in__destination')).toHaveText('1마디에서 시작');
    const stop = page.getByRole('button', { name: '메트로놈 정지', exact: true });
    await expect(stop).toBeFocused();
    const geometry = await popup.evaluate((element) => {
      const card = element.querySelector('.fmr-count-in__card')!;
      const area = element.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      const inside = (a: DOMRect, b: DOMRect) =>
        a.left >= b.left - 1 &&
        a.right <= b.right + 1 &&
        a.top >= b.top - 1 &&
        a.bottom <= b.bottom + 1;
      const button = [
        ...document.querySelectorAll<HTMLElement>('.play-button[aria-label="메트로놈 정지"]'),
      ].find((candidate) => candidate.getBoundingClientRect().height > 0)!;
      const controls = button.getBoundingClientRect();
      return {
        cardInArea: inside(bounds, area),
        contentInCard: [...card.children].every((child) =>
          inside(child.getBoundingClientRect(), bounds),
        ),
        controlsClear:
          bounds.bottom <= controls.top ||
          bounds.top >= controls.bottom ||
          bounds.right <= controls.left ||
          bounds.left >= controls.right,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        pointerEvents: getComputedStyle(element).pointerEvents,
      };
    });
    expect(geometry).toEqual({
      cardInArea: true,
      contentInCard: true,
      controlsClear: true,
      horizontalOverflow: false,
      pointerEvents: 'none',
    });
    if (viewport.width === 390 && viewport.scale === 1) {
      await page.screenshot({ path: testInfo.outputPath('count-in-mobile.png') });
      await expect(popup.locator('.fmr-count-in__value')).toHaveText('2');
      await expect(popup.locator('.fmr-count-in__value')).toHaveText('1');
      await expect(popup.locator('.fmr-count-in__value')).toHaveText('0');
      await expect(page.locator('.performance-context strong')).toHaveText('마디 1 · 예비박 0');
      await expect(popup).toHaveCount(0);
      await expect(page.locator('.performance-context strong')).toHaveText('마디 1');
    }
    await stop.click();
    await expect(popup).toHaveCount(0);
    await expect(start).toBeVisible();
  });
}

test('count-in popup follows focus mode and reduced motion, and stays absent when disabled', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.setItem('fmr.countInEnabled', 'true');
    localStorage.setItem('fmr.countInMeasures', '1');
  });
  await page.goto('/feelmyrythm/');
  await page.getByRole('button', { name: '집중 화면', exact: true }).click();
  await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
  const popup = page.locator('.fmr-count-in');
  await expect(popup).toHaveCount(1);
  await expect(popup.locator('.fmr-count-in__value')).toHaveText('3');
  await expect(popup.locator('.fmr-count-in__value')).toHaveCSS('animation-name', 'none');
  await expect(popup.locator('.fmr-count-in__value')).toHaveText('2');
  await expect(popup.locator('.fmr-count-in__value')).toHaveText('1');
  await expect(popup.locator('.fmr-count-in__value')).toHaveText('0');
  await expect(popup).toHaveCount(0);
  await page.getByRole('button', { name: '메트로놈 정지', exact: true }).click();
  await page.getByRole('button', { name: '집중 화면 나가기', exact: true }).click();
  await page.getByRole('button', { name: '세부 설정' }).click();
  const settings = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
  await settings.getByRole('button', { name: '예비박', exact: true }).click();
  await settings.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
  await expect(page.locator('.performance-context strong')).toHaveText('마디 1');
  await expect(popup).toHaveCount(0);
  await page.getByRole('button', { name: '메트로놈 정지', exact: true }).click();
});
