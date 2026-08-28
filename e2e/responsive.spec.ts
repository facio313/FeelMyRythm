import { expect, test, type Page } from '@playwright/test';

interface RouteContract {
  path: string;
  heading: string;
  primary: string;
  cta: string;
}

const routes: RouteContract[] = [
  { path: '', heading: '메트로놈', primary: '.metronome-stage', cta: '.play-button' },
  {
    path: 'editor',
    heading: '템포맵 편집기',
    primary: '.timeline-card',
    cta: 'button:has-text("저장")',
  },
  {
    path: 'session',
    heading: '앙상블 세션',
    primary: '.session-gate',
    cta: 'button:has-text("로그인")',
  },
  { path: 'scores', heading: '악보', primary: '.fmr-empty', cta: 'button:has-text("파일 선택")' },
  {
    path: 'practice',
    heading: '연습일지',
    primary: '.practice-form',
    cta: 'button:has-text("일지 저장")',
  },
  { path: 'tuner', heading: '튜너', primary: '.tuner-card', cta: 'button:has-text("튜닝 시작")' },
  {
    path: 'dashboard',
    heading: '프로젝트',
    primary: '.dashboard-callout',
    cta: 'button:has-text("로그인")',
  },
  { path: 'settings', heading: '설정', primary: '.theme-picker', cta: 'button:has-text("저장")' },
  {
    path: 'login',
    heading: '다시 연습을 시작하세요',
    primary: '.auth-card',
    cta: 'button:has-text("로그인")',
  },
  {
    path: 'calibration',
    heading: '출력 지연 보정',
    primary: '.calibration-card',
    cta: 'button:has-text("측정 시작")',
  },
  {
    path: 'privacy',
    heading: '개인정보 처리 안내',
    primary: '.legal-page__sections',
    cta: 'a:has-text("계정 삭제 안내 열기")',
  },
  {
    path: 'delete-account',
    heading: 'FeelMyRythm 계정 삭제',
    primary: '.legal-page__sections',
    cta: 'button:has-text("로그인하고 삭제 계속하기")',
  },
];

const viewports = [
  { name: 'effective-short-256', width: 256, height: 480 },
  { name: 'effective-256', width: 256, height: 568 },
  { name: 'phone-short-320', width: 320, height: 480 },
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-boundary-320-701', width: 320, height: 701 },
  { name: 'phone-short-375', width: 375, height: 480 },
  { name: 'phone-375', width: 375, height: 667 },
  { name: 'phone-boundary-375-701', width: 375, height: 701 },
  { name: 'phone-short-390', width: 390, height: 480 },
  { name: 'phone-boundary-390-701', width: 390, height: 701 },
  { name: 'phone-boundary-390-821', width: 390, height: 821 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-wide-short', width: 430, height: 540 },
  { name: 'phone-wide-boundary-430-701', width: 430, height: 701 },
  { name: 'phone-430', width: 430, height: 932 },
  { name: 'phone-split-wide', width: 599, height: 600 },
  { name: 'phone-split-boundary-599-701', width: 599, height: 701 },
  { name: 'phone-split-boundary-599-720', width: 599, height: 720 },
  { name: 'phone-split-boundary-599-821', width: 599, height: 821 },
  { name: 'phone-split-compact-exit-599-900', width: 599, height: 900 },
  { name: 'phone-split-after-compact-599-901', width: 599, height: 901 },
  { name: 'phone-landscape', width: 667, height: 375 },
  { name: 'small-tablet-square', width: 600, height: 600 },
  { name: 'medium-breakpoint-600-701', width: 600, height: 701 },
  { name: 'medium-short-600-768', width: 600, height: 768 },
  { name: 'medium-boundary-600-821', width: 600, height: 821 },
  { name: 'medium-near-square-700-701', width: 700, height: 701 },
  { name: 'tablet-short-landscape', width: 768, height: 600 },
  { name: 'tablet-breakpoint-768-701', width: 768, height: 701 },
  { name: 'tablet-height-boundary-768-821', width: 768, height: 821 },
  { name: 'medium-height-boundary-820-821', width: 820, height: 821 },
  { name: 'medium-width-boundary-839-840', width: 839, height: 840 },
  { name: 'medium-upper-boundary-839-820', width: 839, height: 820 },
  { name: 'medium-tall-839-960', width: 839, height: 960 },
  { name: 'medium-tall-839-961', width: 839, height: 961 },
  { name: 'medium-compact-exit-839-1180', width: 839, height: 1180 },
  { name: 'medium-after-compact-839-1181', width: 839, height: 1181 },
  { name: 'desktop-edge-840-390', width: 840, height: 390 },
  { name: 'desktop-edge-844-390', width: 844, height: 390 },
  { name: 'desktop-short-1024-390', width: 1024, height: 390 },
  { name: 'desktop-recovery-boundary-840-420', width: 840, height: 420 },
  { name: 'desktop-after-recovery-840-421', width: 840, height: 421 },
  { name: 'desktop-short-840-480', width: 840, height: 480 },
  { name: 'desktop-compact-exit-840-640', width: 840, height: 640 },
  { name: 'desktop-after-compact-840-641', width: 840, height: 641 },
  { name: 'small-tablet-portrait', width: 600, height: 960 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'notebook', width: 1280, height: 720 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'large-desktop', width: 1920, height: 1080 },
  { name: 'wide', width: 2560, height: 1440 },
] as const;

interface LayoutAudit {
  documentOverflow: number;
  escaped: string[];
  navOverlaps: string[];
  undersized: string[];
}

async function auditLayout(page: Page): Promise<LayoutAudit> {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const allowedOverflow = '.measure-timeline, .section-table, .score-parts, .score-stage';
    const visible = (element: Element): element is HTMLElement => {
      const node = element as HTMLElement;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const label = (element: Element): string => {
      const node = element as HTMLElement;
      const text = node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '';
      const token = [
        node.tagName.toLowerCase(),
        node.id && `#${node.id}`,
        node.className && `.${String(node.className).split(/\s+/).join('.')}`,
      ]
        .filter(Boolean)
        .join('');
      return `${token}${text ? `:${text.slice(0, 36)}` : ''}`;
    };

    const escaped = [...document.querySelectorAll('#main-content *')]
      .filter(visible)
      .filter((element) => !element.closest(allowedOverflow))
      .filter((element) => !element.closest('[aria-hidden="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > viewportWidth + 1;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${label(element)} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`;
      })
      .slice(0, 12);

    const navigation = document.querySelector<HTMLElement>('.bottom-nav');
    const navRect = navigation && visible(navigation) ? navigation.getBoundingClientRect() : null;
    const interactiveSelector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="radio"], [role="tab"]';
    const interactive = [...document.querySelectorAll<HTMLElement>(interactiveSelector)].filter(
      visible,
    );

    const navOverlaps = navRect
      ? interactive
          .filter((element) => !element.closest('.bottom-nav'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const main = element.closest('#main-content') as HTMLElement | null;
            const clip = main?.getBoundingClientRect();
            const visibleRect = clip
              ? {
                  left: Math.max(rect.left, clip.left),
                  right: Math.min(rect.right, clip.right),
                  top: Math.max(rect.top, clip.top),
                  bottom: Math.min(rect.bottom, clip.bottom),
                }
              : rect;
            const onScreen =
              visibleRect.bottom > Math.max(0, visibleRect.top) &&
              visibleRect.top < viewportHeight &&
              visibleRect.right > Math.max(0, visibleRect.left) &&
              visibleRect.left < viewportWidth;
            const intersects =
              visibleRect.left < navRect.right &&
              visibleRect.right > navRect.left &&
              visibleRect.top < navRect.bottom &&
              visibleRect.bottom > navRect.top;
            return onScreen && intersects;
          })
          .map(label)
          .slice(0, 12)
      : [];

    const undersized = interactive
      .filter((element) => {
        if (element.closest('[aria-hidden="true"]')) return false;
        const rect = element.getBoundingClientRect();
        const input = element as HTMLInputElement;
        if (input.type === 'checkbox' || input.type === 'radio') {
          const labelElement = input.closest('label');
          if (labelElement) {
            const labelRect = labelElement.getBoundingClientRect();
            return labelRect.width < 44 || labelRect.height < 44;
          }
        }
        return rect.width < 44 || rect.height < 44;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${label(element)} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`;
      })
      .slice(0, 12);

    return {
      documentOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - viewportWidth,
        document.body.scrollWidth - viewportWidth,
      ),
      escaped,
      navOverlaps,
      undersized,
    };
  });
}

for (const viewport of viewports) {
  const metronomeCompactHeightLimit =
    viewport.width <= 599 ? 900 : viewport.width <= 839 ? 820 : viewport.width >= 840 ? 640 : 0;

  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.describe.configure({ timeout: 90_000 });

    test('reflows every primary route without clipping or covered controls', async ({ page }) => {
      await page.setViewportSize(viewport);

      for (const route of routes) {
        await test.step(route.path || 'metronome', async () => {
          await page.goto(`/feelmyrythm/${route.path}`);
          const heading = page.getByRole('heading', { level: 1, name: route.heading });
          await expect(heading).toBeAttached();
          await expect(page.locator(route.primary).first()).toBeVisible();
          const cta = page.locator(route.cta).first();
          await expect(cta).toBeAttached();
          await expect
            .poll(() => heading.evaluate((element) => document.activeElement === element))
            .toBe(true);

          const ctaRect = await cta.boundingBox();
          expect(ctaRect, `${route.path || '/'} primary action has geometry`).not.toBeNull();
          expect(
            ctaRect!.y,
            `${route.path || '/'} primary action is reachable within one normal viewport scroll`,
          ).toBeLessThanOrEqual(viewport.height * 2);

          const audit = await auditLayout(page);
          expect(
            audit.documentOverflow,
            `${route.path || '/'} document overflow`,
          ).toBeLessThanOrEqual(1);
          expect(audit.escaped, `${route.path || '/'} clipped descendants`).toEqual([]);
          expect(audit.navOverlaps, `${route.path || '/'} fixed navigation overlaps`).toEqual([]);
          expect(audit.undersized, `${route.path || '/'} undersized targets`).toEqual([]);

          if (route.path === '') {
            const playRect = await page.locator('.play-button').boundingBox();
            const navigationRect = await page.locator('.bottom-nav').boundingBox();
            expect(playRect).not.toBeNull();
            expect(playRect!.y + playRect!.height).toBeLessThanOrEqual(viewport.height + 1);
            if (navigationRect && navigationRect.width >= viewport.width * 0.8) {
              expect(
                playRect!.y + playRect!.height,
                'play control stays completely above fixed navigation',
              ).toBeLessThanOrEqual(navigationRect.y + 1);
            }
            const contentOverlap = await page.evaluate(() => {
              const context = document
                .querySelector('.performance-context')
                ?.getBoundingClientRect();
              const controls = document
                .querySelector('.metronome-controls')
                ?.getBoundingClientRect();
              return context && controls
                ? context.left < controls.right &&
                    context.right > controls.left &&
                    context.top < controls.bottom &&
                    context.bottom > controls.top
                : null;
            });
            expect(contentOverlap, 'status content has measurable geometry').not.toBeNull();
            expect(contentOverlap, 'status content does not overlap the controls').toBe(false);

            if (viewport.width <= 599 && viewport.height <= 900) {
              const tapTempo = page.getByRole('button', { name: '탭 템포' });
              await expect(page.getByRole('button', { name: 'BPM 5 낮추기' })).toBeVisible();
              await expect(tapTempo).toBeVisible();
              await expect(page.getByRole('button', { name: 'BPM 5 높이기' })).toBeVisible();
              if (viewport.width <= 359) await expect(tapTempo).toHaveCSS('font-size', '0px');
            }

            if (viewport.width <= 419) {
              await expect(page.locator('.tap-button')).toHaveCSS('white-space', 'nowrap');
              await expect(page.locator('.tap-button__optional-label')).toBeHidden();
            }

            if (viewport.height <= 539) {
              const settings = page.getByRole('button', { name: '세부 설정' });
              await expect(settings).toBeVisible();
              await settings.click();
              const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
              await expect(dialog).toBeVisible();
              await expect(dialog.getByRole('spinbutton', { name: '시작 마디' })).toBeVisible();
              await expect(dialog.getByRole('slider')).toBeVisible();
              await expect(dialog.getByRole('combobox')).toBeVisible();
              await dialog.getByRole('button', { name: '닫기' }).click();
            }

            if (viewport.height <= metronomeCompactHeightLimit + 1) {
              const recoveryLayout = await page.locator('.metronome-page').evaluate((container) => {
                const stage = container.querySelector<HTMLElement>('.metronome-stage');
                const navigation = document.querySelector<HTMLElement>('.bottom-nav');
                if (!stage || !navigation) throw new Error('Compact metronome regions are missing');

                const status = document.createElement('div');
                status.className = 'metronome-map-status';
                const message = document.createElement('span');
                message.textContent =
                  '서버에 연결할 수 없어 검증된 오프라인 캐시를 사용합니다. 현재 상태를 확인하세요.';
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'fmr-button';
                retry.textContent = '다시 시도';
                status.append(message, retry);
                container.insertBefore(status, stage);

                const navRect = navigation.getBoundingClientRect();
                const statusRect = status.getBoundingClientRect();
                const visibleControls = [
                  ...container.querySelectorAll<HTMLElement>('.metronome-controls button'),
                ].filter((element) => {
                  const style = getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return style.display !== 'none' && rect.width > 0 && rect.height > 0;
                });
                const maxControlBottom = Math.max(
                  ...visibleControls.map((element) => element.getBoundingClientRect().bottom),
                );
                const stageRect = stage.getBoundingClientRect();
                status.remove();
                return {
                  maxControlBottom,
                  navTop: navRect.top,
                  horizontalNavigation: navRect.width >= window.innerWidth * 0.8,
                  stageTop: stageRect.top,
                  statusBottom: statusRect.bottom,
                  statusHeight: statusRect.height,
                };
              });
              if (recoveryLayout.horizontalNavigation) {
                expect(
                  recoveryLayout.maxControlBottom,
                  'recovery state controls stay above fixed navigation',
                ).toBeLessThanOrEqual(recoveryLayout.navTop + 1);
              }
              expect(
                recoveryLayout.maxControlBottom,
                'recovery state controls stay inside the viewport',
              ).toBeLessThanOrEqual(viewport.height + 1);
              expect(
                recoveryLayout.statusBottom,
                'recovery status stays above the metronome stage',
              ).toBeLessThanOrEqual(recoveryLayout.stageTop);
              expect(recoveryLayout.statusHeight).toBeLessThanOrEqual(
                viewport.height <= metronomeCompactHeightLimit ? 48 : 72,
              );
            }
          }
        });
      }
    });
  });
}

test('idle metronome geometry follows width and height changes before playback', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto('/feelmyrythm/');
  await expect(page.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled();
  const canvas = page.locator('.metronome-visualizer canvas');
  const stagePage = page.locator('.metronome-page');

  await stagePage.evaluate((element) => {
    element.setAttribute('data-playing', 'true');
    element.setAttribute('data-beat-tone', 'downbeat');
  });
  await expect(stagePage).toHaveCSS('background-image', /radial-gradient/);
  await stagePage.evaluate((element) => element.setAttribute('data-beat-tone', 'beat'));
  await expect(stagePage).toHaveCSS('background-image', 'none');
  await stagePage.evaluate((element) => element.removeAttribute('data-playing'));

  const canvasMatchesCssSize = () =>
    canvas.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      return {
        heightError: Math.abs(element.height - Math.round(bounds.height * ratio)),
        widthError: Math.abs(element.width - Math.round(bounds.width * ratio)),
      };
    });
  await expect.poll(canvasMatchesCssSize).toEqual({ heightError: 0, widthError: 0 });
  const regularHeight = await canvas.evaluate((element) => element.getBoundingClientRect().height);

  await page.setViewportSize({ width: 1_440, height: 1_200 });
  await expect.poll(canvasMatchesCssSize).toEqual({ heightError: 0, widthError: 0 });
  const tallHeight = await canvas.evaluate((element) => element.getBoundingClientRect().height);
  expect(tallHeight).toBeGreaterThan(regularHeight + 40);

  const verticalRhythm = await page.evaluate(() => {
    const stage = document.querySelector('.metronome-stage')?.getBoundingClientRect();
    const visualizer = document.querySelector('.metronome-visualizer')?.getBoundingClientRect();
    const context = document.querySelector('.performance-context')?.getBoundingClientRect();
    const controls = document.querySelector('.metronome-controls')?.getBoundingClientRect();
    return stage && visualizer && context && controls
      ? {
          gap: controls.top - stage.bottom,
          contentGap: controls.top - context.bottom,
          stageBottomPadding: stage.bottom - context.bottom,
          stageTopPadding: visualizer.top - stage.top,
          stageBottom: stage.bottom,
          controlsTop: controls.top,
        }
      : null;
  });
  expect(verticalRhythm).not.toBeNull();
  expect(verticalRhythm!.gap).toBeGreaterThanOrEqual(0);
  expect(verticalRhythm!.gap).toBeLessThanOrEqual(20);
  expect(verticalRhythm!.contentGap).toBeGreaterThanOrEqual(0);
  expect(verticalRhythm!.contentGap).toBeLessThanOrEqual(48);
  expect(verticalRhythm!.stageBottomPadding).toBeLessThanOrEqual(36);
  expect(verticalRhythm!.stageTopPadding).toBeLessThanOrEqual(36);

  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(canvasMatchesCssSize).toEqual({ heightError: 0, widthError: 0 });
  const meterGeometry = await page.locator('.meter-select__control').evaluate((control) => {
    const select = control.querySelector('select');
    const icon = control.querySelector('svg');
    if (!select || !icon) return null;
    const selectBounds = select.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return {
      appearance: getComputedStyle(select).appearance,
      centerDelta: Math.abs(
        selectBounds.top + selectBounds.height / 2 - (iconBounds.top + iconBounds.height / 2),
      ),
    };
  });
  expect(meterGeometry).not.toBeNull();
  expect(meterGeometry!.appearance).toBe('none');
  expect(meterGeometry!.centerDelta).toBeLessThanOrEqual(1);
  const compactRhythm = await page.evaluate(() => {
    const context = document.querySelector('.performance-context')?.getBoundingClientRect();
    const controls = document.querySelector('.metronome-controls')?.getBoundingClientRect();
    return context && controls ? controls.top - context.bottom : null;
  });
  expect(compactRhythm).not.toBeNull();
  expect(compactRhythm!).toBeGreaterThanOrEqual(0);
  expect((await auditLayout(page)).documentOverflow).toBeLessThanOrEqual(1);
});

test('short-screen metronome settings stay aligned in a centered dialog', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto('/feelmyrythm/');
  const settings = page.getByRole('button', { name: '세부 설정' });
  await expect(settings).toBeVisible();
  await settings.click();

  const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: '시작 마디' })).toBeVisible();
  const alignment = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      horizontalDelta: Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
      verticalDelta: Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2),
    };
  });
  expect(alignment.horizontalDelta).toBeLessThanOrEqual(1);
  expect(alignment.verticalDelta).toBeLessThanOrEqual(1);
});

test('start measure stays available in compact and tall-medium layouts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feelmyrythm/');
  const compactSettings = page.getByRole('button', { name: '세부 설정' });
  await expect(compactSettings).toBeVisible();
  await compactSettings.click();
  const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
  const dialogStartMeasure = dialog.getByRole('spinbutton', { name: '시작 마디' });
  await expect(dialogStartMeasure).toBeVisible();
  await dialogStartMeasure.fill('4');
  await expect(dialogStartMeasure).toHaveValue('4');
  await dialog.getByRole('button', { name: '닫기' }).click();

  await page.setViewportSize({ width: 768, height: 1_024 });
  await expect(page.locator('.metronome-settings')).toBeVisible();
  await expect(page.getByRole('button', { name: '세부 설정' })).toBeHidden();
  const inlineStartMeasure = page.locator('.quick-settings').getByRole('spinbutton', {
    name: '시작 마디',
  });
  await expect(inlineStartMeasure).toBeVisible();
  await expect(inlineStartMeasure).toHaveValue('4');
});

test('settings dialog restores focus when its compact trigger disappears', async ({ page }) => {
  for (const boundary of [
    { width: 599, compactHeight: 900, restoredHeight: 901 },
    { width: 768, compactHeight: 820, restoredHeight: 821 },
  ]) {
    await page.setViewportSize({ width: boundary.width, height: boundary.compactHeight });
    await page.goto('/feelmyrythm/');
    const settings = page.getByRole('button', { name: '세부 설정' });
    await expect(settings).toBeVisible();
    await settings.click();

    const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: boundary.width, height: boundary.restoredHeight });
    await expect(settings).toBeHidden();
    await dialog.getByRole('button', { name: '닫기' }).click();

    const inlineStartMeasure = page.locator('.quick-settings').getByRole('spinbutton', {
      name: '시작 마디',
    });
    await expect(inlineStartMeasure).toBeVisible();
    await expect(inlineStartMeasure).toBeFocused();
  }
});

test('medium-height layout restores inline settings without a large boundary jump', async ({
  page,
}) => {
  const geometry = async (height: number) => {
    await page.setViewportSize({ width: 839, height });
    await page.goto('/feelmyrythm/');
    return page.locator('.metronome-page').evaluate((container) => {
      const stage = container.querySelector<HTMLElement>('.metronome-stage');
      const settings = container.querySelector<HTMLElement>('.metronome-settings');
      const shortSettings = container.querySelector<HTMLElement>(
        '.metronome-heading__short-settings',
      );
      if (!stage || !settings || !shortSettings) throw new Error('Metronome regions are missing');
      const stageRect = stage.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      return {
        pageBottom: container.getBoundingClientRect().bottom,
        settingsVisible: getComputedStyle(settings).display !== 'none' && settingsRect.height > 0,
        shortSettingsVisible:
          getComputedStyle(shortSettings).display !== 'none' &&
          shortSettings.getBoundingClientRect().height > 0,
        stageHeight: stageRect.height,
      };
    });
  };

  const compact = await geometry(820);
  const restored = await geometry(821);
  const beforeExit = await geometry(1_180);
  const afterExit = await geometry(1_181);

  expect(compact.settingsVisible).toBe(false);
  expect(compact.shortSettingsVisible).toBe(true);
  expect(restored.settingsVisible).toBe(true);
  expect(restored.shortSettingsVisible).toBe(false);
  expect(Math.abs(restored.stageHeight - compact.stageHeight)).toBeLessThanOrEqual(40);
  expect(beforeExit.settingsVisible).toBe(true);
  expect(afterExit.settingsVisible).toBe(true);
  expect(Math.abs(afterExit.stageHeight - beforeExit.stageHeight)).toBeLessThanOrEqual(120);
  expect(Math.abs(afterExit.pageBottom - beforeExit.pageBottom)).toBeLessThanOrEqual(180);
});

test('compact coarse-pointer controls keep 48px targets without overflow', async ({ browser }) => {
  test.setTimeout(120_000);

  for (const viewport of [
    { width: 256, height: 480 },
    { width: 359, height: 420 },
    { width: 390, height: 420 },
    { width: 375, height: 480 },
    { width: 320, height: 701 },
    { width: 390, height: 701 },
    { width: 390, height: 844 },
    { width: 599, height: 720 },
    { width: 599, height: 900 },
    { width: 600, height: 600 },
    { width: 768, height: 701 },
    { width: 768, height: 821 },
    { width: 839, height: 820 },
    { width: 839, height: 960 },
    { width: 839, height: 1180 },
    { width: 839, height: 1181 },
  ]) {
    const context = await browser.newContext({
      viewport,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.goto('/feelmyrythm/');
    await expect(page.getByRole('button', { name: '메트로놈 재생' })).toBeEnabled();
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);

    for (const name of ['메트로놈 재생', 'BPM 5 낮추기', '탭 템포', 'BPM 5 높이기', '예비박']) {
      const target = page.getByRole('button', { name, exact: true });
      await expect(target).toBeVisible();
      const bounds = await target.boundingBox();
      expect(bounds, `${viewport.width}px ${name} target has geometry`).not.toBeNull();
      expect(bounds!.width, `${viewport.width}px ${name} target width`).toBeGreaterThanOrEqual(48);
      expect(bounds!.height, `${viewport.width}px ${name} target height`).toBeGreaterThanOrEqual(
        48,
      );
    }
    const visibleCountInText = await page
      .locator('.count-in-button')
      .evaluate((element) => (element as HTMLElement).innerText);
    expect(visibleCountInText).toContain('예비');
    expect(visibleCountInText).toMatch(/켬|끔/);

    await page.locator('.metronome-page').evaluate((container) => {
      const stage = container.querySelector('.metronome-stage');
      if (!stage) throw new Error('Metronome stage is missing');
      const status = document.createElement('div');
      status.id = 'coarse-test-status';
      status.className = 'metronome-map-status';
      const message = document.createElement('span');
      message.textContent = '서버에 연결할 수 없어 검증된 오프라인 캐시를 사용합니다.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'fmr-button';
      retry.textContent = '다시 시도';
      status.append(message, retry);
      container.insertBefore(status, stage);
    });

    const retry = page.getByRole('button', { name: '다시 시도', exact: true });
    const retryBounds = await retry.boundingBox();
    const bpmBounds = await page.locator('.bpm-display > button').boundingBox();
    expect(retryBounds).not.toBeNull();
    expect(retryBounds!.height).toBeGreaterThanOrEqual(48);
    expect(bpmBounds).not.toBeNull();
    expect(bpmBounds!.height).toBeGreaterThanOrEqual(48);
    const audit = await auditLayout(page);
    expect(audit.documentOverflow).toBeLessThanOrEqual(1);
    expect(audit.navOverlaps).toEqual([]);
    if (viewport.height === 420 && viewport.width >= 359 && viewport.width <= 390) {
      const recoveryGeometry = await page.locator('.metronome-page').evaluate((container) => {
        const main = container.closest<HTMLElement>('#main-content');
        const status = container.querySelector<HTMLElement>('#coarse-test-status');
        const stage = container.querySelector<HTMLElement>('.metronome-stage');
        const controls = container.querySelector<HTMLElement>('.metronome-controls');
        if (!main || !status || !stage || !controls) {
          throw new Error('Compact recovery regions are missing');
        }
        const mainRect = main.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const controlsRect = controls.getBoundingClientRect();
        return {
          controlsFullyVisible:
            controlsRect.top >= mainRect.top - 1 && controlsRect.bottom <= mainRect.bottom + 1,
          statusClearsStage: statusRect.bottom <= stageRect.top + 1,
        };
      });
      expect(recoveryGeometry.controlsFullyVisible, `${viewport.width}x420 controls`).toBe(true);
      expect(recoveryGeometry.statusClearsStage, `${viewport.width}x420 status`).toBe(true);
    }
    await page.locator('#coarse-test-status').evaluate((element) => element.remove());
    await context.close();
  }
});

test('coarse pointer, large text, keyboard and reduced motion keep controls usable', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto('/feelmyrythm/settings');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });

  const volume = page.getByRole('slider', { name: '볼륨' });
  await expect(volume).toBeVisible();
  const rangeBox = await volume.boundingBox();
  expect(rangeBox).not.toBeNull();
  expect(rangeBox!.height).toBeGreaterThanOrEqual(48);

  const countIn = page.getByLabel('예비박 마디');
  await expect(countIn).toHaveCSS('min-height', '48px');
  const inputBox = await countIn.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.height).toBeGreaterThanOrEqual(48);
  await countIn.focus();
  await expect(page.locator('.bottom-nav')).toBeHidden();
  expect((await auditLayout(page)).escaped).toEqual([]);

  await page.goto('/feelmyrythm/');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  const settings = page.getByRole('button', { name: '세부 설정' });
  await expect(settings).toBeVisible();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
  await expect(dialog).toBeVisible();
  const meter = dialog.getByRole('combobox', { name: '박자' });
  await expect(meter).toBeVisible();
  await expect(meter).toHaveCSS('min-height', '48px');
  const selectBox = await meter.boundingBox();
  expect(selectBox).not.toBeNull();
  expect(selectBox!.height).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
  const playAnimation = await page
    .locator('.play-button')
    .evaluate((element) => getComputedStyle(element, '::after').animationName);
  expect(playAnimation).toBe('none');
  const reducedMotionBackground = await page.locator('.metronome-page').evaluate((element) => {
    element.setAttribute('data-playing', 'true');
    element.setAttribute('data-beat-tone', 'downbeat');
    return getComputedStyle(element).backgroundImage;
  });
  expect(reducedMotionBackground).toBe('none');
  const enlargedTextGap = await page.evaluate(() => {
    const context = document.querySelector('.performance-context')?.getBoundingClientRect();
    const controls = document.querySelector('.metronome-controls')?.getBoundingClientRect();
    return context && controls ? controls.top - context.bottom : null;
  });
  expect(enlargedTextGap).not.toBeNull();
  expect(enlargedTextGap!).toBeGreaterThanOrEqual(0);
  await context.close();
});

test('200% text keeps the primary metronome path clear of the mobile navigation', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  for (const viewport of [
    { width: 256, height: 480 },
    { width: 320, height: 480 },
    { width: 359, height: 480 },
    { width: 390, height: 480 },
    { width: 419, height: 480 },
    { width: 599, height: 700 },
  ]) {
    const context = await browser.newContext({
      viewport,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.goto('/feelmyrythm/');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.documentElement.style.fontSize = '32px';
          requestAnimationFrame(() => resolve());
        }),
    );
    const main = page.locator('#main-content');
    const nav = page.locator('.bottom-nav');
    const bpm = page.locator('.bpm-display > button');
    await expect(main).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(bpm).toBeVisible();
    const mainRect = await main.boundingBox();
    const navRect = await nav.boundingBox();
    const bpmRect = await bpm.boundingBox();
    expect(mainRect, `${viewport.width}x${viewport.height} main`).not.toBeNull();
    expect(navRect, `${viewport.width}x${viewport.height} nav`).not.toBeNull();
    expect(bpmRect, `${viewport.width}x${viewport.height} BPM`).not.toBeNull();
    const initialGeometry = {
      bpmFullyVisible:
        bpmRect!.y >= mainRect!.y - 1 &&
        bpmRect!.y + bpmRect!.height <= mainRect!.y + mainRect!.height + 1,
      navHeight: navRect!.height,
      navStartsAtMainEnd: Math.abs(navRect!.y - (mainRect!.y + mainRect!.height)),
    };
    expect(initialGeometry.bpmFullyVisible, `${viewport.width}x${viewport.height} BPM`).toBe(true);
    expect(initialGeometry.navHeight).toBeLessThanOrEqual(viewport.width <= 359 ? 88 : 96);
    expect(initialGeometry.navStartsAtMainEnd).toBeLessThanOrEqual(1);

    for (const selector of ['.play-button', '.tap-button', '.count-in-button']) {
      const control = page.locator(selector);
      await control.focus();
      await expect(control).toBeFocused();
      await expect
        .poll(() =>
          control.evaluate((element) => {
            const main = document.querySelector<HTMLElement>('#main-content');
            const nav = document.querySelector<HTMLElement>('.bottom-nav');
            if (!main || !nav) return false;
            const rect = element.getBoundingClientRect();
            const mainRect = main.getBoundingClientRect();
            const navRect = nav.getBoundingClientRect();
            return (
              rect.top >= mainRect.top - 1 &&
              rect.bottom <= mainRect.bottom + 1 &&
              rect.bottom <= navRect.top + 1
            );
          }),
        )
        .toBe(true);
    }

    await context.close();
  }
});

test('BPM dialog keeps its initial focus visible at effective 256px and 200% text', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 256, height: 480 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto('/feelmyrythm/');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });

  await page.locator('.bpm-display > button').click();
  const dialog = page.getByRole('dialog', { name: 'BPM 직접 입력' });
  const input = dialog.getByRole('spinbutton', { name: 'BPM' });
  await expect(input).toBeFocused();

  await expect
    .poll(() =>
      input.evaluate((element) => {
        const inputRect = element.getBoundingClientRect();
        const dialogRect = element.closest('[role="dialog"]')?.getBoundingClientRect();
        return Boolean(
          dialogRect &&
          inputRect.top >= dialogRect.top + 2 &&
          inputRect.bottom <= Math.min(dialogRect.bottom, window.innerHeight) - 2,
        );
      }),
    )
    .toBe(true);

  await context.close();
});
