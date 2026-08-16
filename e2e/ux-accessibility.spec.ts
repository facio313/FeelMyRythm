import { expect, test } from '@playwright/test';

test('667×375 tuner keeps the note, cents reading, and microphone action visible together', async ({
  page,
}) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto('/feelmyrythm/tuner');

  const note = page.locator('.tuner-note');
  const cents = page.locator('.tuner-reading strong');
  const action = page.getByRole('button', { name: '튜닝 시작' });
  await expect(note).toBeVisible();
  await expect(cents).toBeVisible();
  await expect(action).toBeVisible();
  await expect(page.getByRole('meter', { name: '튜닝 편차' })).toHaveAttribute(
    'aria-valuetext',
    '음을 기다리는 중',
  );

  const geometry = await page.evaluate(() => {
    const selectors = ['.tuner-note', '.tuner-reading strong', '.tuner-mic-button'];
    const navigation = document.querySelector('.bottom-nav')?.getBoundingClientRect();
    return selectors.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect
        ? {
            selector,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            overlapsNavigation: navigation
              ? rect.left < navigation.right &&
                rect.right > navigation.left &&
                rect.top < navigation.bottom &&
                rect.bottom > navigation.top
              : false,
          }
        : null;
    });
  });
  for (const item of geometry) {
    expect(item).not.toBeNull();
    expect(item!.top, `${item!.selector} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(item!.left, `${item!.selector} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(item!.right, `${item!.selector} ends inside the viewport`).toBeLessThanOrEqual(
      item!.viewportWidth + 1,
    );
    expect(item!.bottom, `${item!.selector} ends inside the viewport`).toBeLessThanOrEqual(
      item!.viewportHeight + 1,
    );
    expect(item!.overlapsNavigation, `${item!.selector} avoids fixed navigation`).toBe(false);
  }

  const a440 = page.getByRole('radio', { name: '440' });
  const a442 = page.getByRole('radio', { name: '442' });
  await a440.focus();
  await page.keyboard.press('ArrowRight');
  await expect(a442).toBeFocused();
  await expect(a442).toHaveAttribute('aria-checked', 'true');
});

test('stand mode removes hidden controls from focus and exits on a touch double-tap', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: () => {
        fullscreenElement = document.querySelector('.metronome-page');
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      },
    });
    Object.defineProperty(Document.prototype, 'exitFullscreen', {
      configurable: true,
      value: () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      },
    });
  });
  await page.goto('/feelmyrythm/');

  await expect(page).toHaveTitle('메트로놈 · FeelMyRythm');
  await expect(page.locator('#main-content main')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '메트로놈 상태' })).toBeVisible();
  await page.getByRole('button', { name: '보면대 모드' }).click();
  await expect(page.locator('.metronome-page')).toHaveClass(/metronome-page--fullscreen/);

  for (const selector of ['.bpm-steppers', '.quick-settings', '.metronome-settings']) {
    await expect(page.locator(selector)).toHaveAttribute('inert', '');
    const descendantAcceptedFocus = await page.locator(selector).evaluate((container) => {
      const control = container.querySelector<HTMLElement>('button, input, select');
      control?.focus();
      return document.activeElement === control;
    });
    expect(descendantAcceptedFocus, `${selector} descendants stay out of focus`).toBe(false);
  }

  const stage = page.locator('.metronome-stage');
  await stage.dispatchEvent('pointerup', { pointerType: 'touch' });
  await stage.dispatchEvent('pointerup', { pointerType: 'touch' });
  await expect(page.locator('.metronome-page')).not.toHaveClass(/metronome-page--fullscreen/);
});

test('saved light theme is applied at boot and login errors stay field-linked at 256px', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('fmr.theme', 'light'));
  await page.setViewportSize({ width: 256, height: 568 });
  await page.goto('/feelmyrythm/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(
    await page.locator('.topbar').evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgba(250, 248, 243, 0.94)');

  await page.goto('/feelmyrythm/login');
  await expect(page).toHaveTitle('로그인 · FeelMyRythm');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  const email = page.getByLabel('이메일', { exact: true });
  const password = page.getByLabel('비밀번호', { exact: true });
  await expect(email).toHaveAttribute('aria-describedby', 'auth-email-description');
  await expect(password).toHaveAttribute('aria-describedby', 'auth-password-description');

  const overflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
