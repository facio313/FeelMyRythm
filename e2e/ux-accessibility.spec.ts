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
  await expect(page.locator('.metronome-page')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.metronome-number')).toBeHidden();
  await expect(page.locator('.metronome-mobile-controls')).toBeHidden();
  await expect(page.locator('.tap-tempo-panel')).toBeHidden();
  const idleBackground = await page.locator('.metronome-page').evaluate((element) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--bg)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, expected };
  });
  expect(idleBackground.actual).toBe(idleBackground.expected);

  for (const selector of ['.skip-link', '.topbar', '.sidebar', '.bottom-nav']) {
    await expect(page.locator(selector)).toHaveAttribute('inert', '');
    await expect(page.locator(selector)).toHaveAttribute('aria-hidden', 'true');
  }

  for (const selector of [
    '.metronome-heading__editor',
    '.metronome-heading__short-settings',
    '.bpm-display > button',
    '.bpm-steppers',
    '.quick-settings',
    '.metronome-settings',
  ]) {
    await expect(page.locator(selector)).toHaveAttribute('inert', '');
    const descendantAcceptedFocus = await page.locator(selector).evaluate((container) => {
      const control = container.matches('button, input, select')
        ? (container as HTMLElement)
        : container.querySelector<HTMLElement>('button, input, select');
      control?.focus();
      return document.activeElement === control;
    });
    expect(descendantAcceptedFocus, `${selector} descendants stay out of focus`).toBe(false);
  }
  await expect(page.locator('.bpm-display > button > small')).toHaveCount(0);
  await expect(page.locator('.metronome-heading .performance-context')).toHaveCount(0);
  await expect(page.locator('.metronome-stage .performance-context')).toBeVisible();
  await expect(page.locator('.metronome-stage .bpm-display')).toBeVisible();
  await expect(page.locator('.metronome-settings')).toHaveCSS('display', 'none');
  await expect(page.locator('.bpm-steppers')).toHaveCSS('display', 'none');
  await expect(page.locator('.quick-settings')).toHaveCSS('display', 'none');

  for (const viewport of [
    { width: 320, height: 256 },
    { width: 480, height: 320 },
    { width: 256, height: 480 },
    { width: 375, height: 480 },
    { width: 600, height: 375 },
    { width: 768, height: 375 },
    { width: 600, height: 480 },
    { width: 768, height: 480 },
    { width: 840, height: 390 },
    { width: 1_024, height: 390 },
    { width: 768, height: 701 },
    { width: 839, height: 820 },
  ]) {
    for (const withStatus of [false, true]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('.metronome-number')).toBeHidden();
      await expect(page.locator('.metronome-mobile-controls')).toBeHidden();
      await expect(page.locator('.tap-tempo-panel')).toBeHidden();
      const geometry = await page.locator('.metronome-page').evaluate((container, addStatus) => {
        container.querySelector('#fullscreen-test-status')?.remove();
        const stage = container.querySelector<HTMLElement>('.metronome-stage');
        const controls = container.querySelector<HTMLElement>('.metronome-controls');
        const play = container.querySelector<HTMLElement>('.play-button');
        const heading = container.querySelector<HTMLElement>('.metronome-heading');
        const visualizer = container.querySelector<HTMLElement>('.metronome-visualizer');
        const bpm = container.querySelector<HTMLElement>('.bpm-display');
        const context = stage?.querySelector<HTMLElement>('.performance-context');
        if (!stage || !controls || !play || !heading || !visualizer || !bpm || !context) {
          throw new Error('Fullscreen metronome regions are missing');
        }
        let status: HTMLElement | null = null;
        if (addStatus) {
          status = document.createElement('div');
          status.id = 'fullscreen-test-status';
          status.className = 'metronome-map-status';
          status.textContent = '오프라인 캐시 상태';
          container.insertBefore(status, stage);
        }
        const pageRect = container.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const statusRect = status?.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const visualizerRect = visualizer.getBoundingClientRect();
        const bpmRect = bpm.getBoundingClientRect();
        const contextRect = context.getBoundingClientRect();
        const controlsRect = controls.getBoundingClientRect();
        const playRect = play.getBoundingClientRect();
        return {
          bpmBottom: bpmRect.bottom,
          bpmTop: bpmRect.top,
          contextBottom: contextRect.bottom,
          contextTop: contextRect.top,
          controlsLeft: controlsRect.left,
          controlsRight: controlsRect.right,
          controlsTop: controlsRect.top,
          headingBottom: headingRect.bottom,
          pageLeft: pageRect.left,
          pageRight: pageRect.right,
          playCenterDelta: Math.abs(
            playRect.left + playRect.width / 2 - (pageRect.left + pageRect.width / 2),
          ),
          rowCount: getComputedStyle(container).gridTemplateRows.split(' ').length,
          stageBottom: stageRect.bottom,
          stageHeight: stageRect.height,
          stageTop: stageRect.top,
          statusBottom: statusRect?.bottom ?? null,
          statusTop: statusRect?.top ?? null,
          visualizerBottom: visualizerRect.bottom,
          visualizerTop: visualizerRect.top,
        };
      }, withStatus);
      expect(geometry.pageLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.pageRight).toBeLessThanOrEqual(viewport.width);
      expect(geometry.controlsLeft).toBeGreaterThanOrEqual(geometry.pageLeft);
      expect(geometry.controlsRight).toBeLessThanOrEqual(geometry.pageRight);
      expect(geometry.rowCount).toBe(withStatus ? 4 : 3);
      expect(geometry.stageHeight).toBeGreaterThan(0);
      expect(geometry.headingBottom).toBeLessThanOrEqual(
        (geometry.statusTop ?? geometry.stageTop) + 1,
      );
      if (withStatus) {
        expect(geometry.statusBottom).not.toBeNull();
        expect(geometry.statusBottom!).toBeLessThanOrEqual(geometry.stageTop + 1);
      }
      expect(geometry.headingBottom).toBeLessThanOrEqual(geometry.visualizerTop + 1);
      expect(geometry.visualizerBottom).toBeLessThanOrEqual(geometry.bpmTop + 1);
      expect(geometry.bpmBottom).toBeLessThanOrEqual(geometry.contextTop + 1);
      expect(geometry.contextBottom).toBeLessThanOrEqual(geometry.controlsTop + 1);
      expect(geometry.stageBottom).toBeLessThanOrEqual(geometry.controlsTop + 1);
      expect(geometry.playCenterDelta).toBeLessThanOrEqual(1);
      if (viewport.height <= 319) {
        await expect(page.locator('.metronome-page')).toHaveCSS('overflow-y', 'auto');
      }
    }
  }

  await page.locator('#fullscreen-test-status').evaluate((element) => element.remove());

  const stage = page.locator('.metronome-stage');
  await stage.dispatchEvent('pointerup', { pointerType: 'touch' });
  await stage.dispatchEvent('pointerup', { pointerType: 'touch' });
  await expect(page.locator('.metronome-page')).not.toHaveClass(/metronome-page--fullscreen/);
  for (const selector of ['.skip-link', '.topbar', '.sidebar', '.bottom-nav']) {
    await expect(page.locator(selector)).not.toHaveAttribute('inert', '');
    await expect(page.locator(selector)).not.toHaveAttribute('aria-hidden', 'true');
  }
});

test('saved light theme is applied at boot and login errors stay field-linked at 256px', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('fmr.theme', 'light'));
  await page.setViewportSize({ width: 256, height: 568 });
  await page.goto('/feelmyrythm/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.topbar')).toBeHidden();
  expect(
    await page.locator('.bottom-nav').evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgba(250, 248, 243, 0.96)');
  expect(
    Number.parseFloat(
      await page
        .locator('.bottom-nav__link')
        .first()
        .evaluate((node) => getComputedStyle(node).fontSize),
    ),
  ).toBeGreaterThanOrEqual(11);

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

test('mobile More keeps account and theme controls available and preserves theme across reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 256, height: 568 });
  await page.goto('/feelmyrythm/');

  await expect(page.locator('.topbar')).toBeHidden();
  await page.getByRole('button', { name: '더보기', exact: true }).click();
  const more = page.getByRole('dialog', { name: '더보기', exact: true });
  await expect(more).toBeVisible();
  await expect(more.getByRole('link', { name: '← Bonifacio' })).toHaveAttribute(
    'href',
    'https://bonifacio.work/',
  );
  await expect(more.getByRole('link', { name: '설정', exact: true })).toBeVisible();
  await expect(more.getByRole('link', { name: '로그인', exact: true })).toHaveAttribute(
    'href',
    '/feelmyrythm/login',
  );
  const toggle = more.getByRole('button', { name: '라이트 테마로 전환' });
  await expect(toggle).toBeVisible();
  const toggleBounds = await toggle.boundingBox();
  expect(toggleBounds).not.toBeNull();
  expect(toggleBounds!.width).toBeGreaterThanOrEqual(44);
  expect(toggleBounds!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#FAF8F3');
  expect(await page.evaluate(() => localStorage.getItem('fmr.theme'))).toBe('light');
  await more.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(/\/feelmyrythm\/settings$/);
  await expect(more).toBeHidden();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '더보기', exact: true }).click();
  await expect(more.getByRole('button', { name: '다크 테마로 전환' })).toBeVisible();
  await more.getByRole('button', { name: '닫기', exact: true }).click();
  await page.setViewportSize({ width: 839, height: 844 });
  await expect(page.locator('.topbar')).toBeHidden();
  await page.setViewportSize({ width: 840, height: 844 });
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(
    page.locator('.topbar').getByRole('button', { name: '다크 테마로 전환' }),
  ).toBeVisible();
});

test('selected semantic text and control pairs keep WCAG AA contrast in both themes', async ({
  page,
}) => {
  await page.goto('/feelmyrythm/');

  for (const theme of ['dark', 'light'] as const) {
    const ratios = await page.locator('html').evaluate((root, selectedTheme) => {
      root.dataset.theme = selectedTheme;
      const styles = getComputedStyle(root);
      const rgb = (token: string) => {
        const value = styles.getPropertyValue(token).trim();
        const hex = value.replace('#', '');
        const channels =
          hex.length === 3
            ? [...hex].map((channel) => Number.parseInt(`${channel}${channel}`, 16))
            : [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
        return channels.map((channel) => channel / 255);
      };
      const luminance = (token: string) =>
        rgb(token)
          .map((channel) =>
            channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
          )
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
      const contrast = (foreground: string, background: string) => {
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };

      return {
        text: {
          accentOnBackground: contrast('--accent', '--bg'),
          accentOnSurface: contrast('--accent', '--surface'),
          primaryOnBackground: contrast('--text', '--bg'),
          primaryOnSurface: contrast('--text', '--surface'),
          primaryOnRaised: contrast('--text', '--surface-raised'),
          secondaryOnBackground: contrast('--text-secondary', '--bg'),
          secondaryOnSurface: contrast('--text-secondary', '--surface'),
          secondaryOnRaised: contrast('--text-secondary', '--surface-raised'),
          mutedOnBackground: contrast('--text-muted', '--bg'),
          mutedOnSurface: contrast('--text-muted', '--surface'),
          mutedOnRaised: contrast('--text-muted', '--surface-raised'),
          textOnAccent: contrast('--on-accent', '--accent'),
        },
        nonText: {
          controlBorderOnRaised: contrast('--control-border', '--surface-raised'),
          controlBorderOnSurface: contrast('--control-border', '--surface'),
          progressTrackOnBackground: contrast('--control-border', '--bg'),
        },
      };
    }, theme);

    for (const [pair, ratio] of Object.entries(ratios.text)) {
      expect(ratio, `${theme} ${pair} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [pair, ratio] of Object.entries(ratios.nonText)) {
      expect(ratio, `${theme} ${pair} contrast`).toBeGreaterThanOrEqual(3);
    }
  }
});
