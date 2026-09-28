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
              await expect(tapTempo).toHaveText('탭');
              await expect(tapTempo).toHaveCSS('font-size', '11px');
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
    const number = document.querySelector('.metronome-number')?.getBoundingClientRect();
    const context = document.querySelector('.performance-context')?.getBoundingClientRect();
    const controls = document.querySelector('.metronome-controls')?.getBoundingClientRect();
    return stage && visualizer && context && controls
      ? {
          gap: controls.top - stage.bottom,
          contentGap: controls.top - context.bottom,
          stageBottomPadding: stage.bottom - context.bottom,
          stageTopPadding: (number && number.height > 0 ? number.top : visualizer.top) - stage.top,
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

  await expect(page.locator('.metronome-controls .count-in-button')).toHaveCount(0);
  const countIn = dialog.getByRole('button', { name: '예비박', exact: true });
  await expect(countIn).toHaveAttribute('aria-pressed', 'true');
  await countIn.click();
  await expect(countIn).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('fmr.countInEnabled'))).toBe('false');
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();

  await page.reload();
  await settings.click();
  await expect(countIn).toHaveAttribute('aria-pressed', 'false');
  await countIn.focus();
  await page.keyboard.press('Space');
  await expect(countIn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('fmr.countInEnabled'))).toBe('true');
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();

  const metronome = page.locator('.metronome-page');
  await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
  await expect(metronome).toHaveAttribute('data-count-in', 'true');
  await expect(page.locator('.metronome-heading .performance-context strong')).toHaveText(
    /예비박 \d+/,
  );
  await expect(metronome).not.toHaveAttribute('data-count-in', 'true');
  await expect(page.locator('.metronome-heading .performance-context strong')).toHaveText(
    /마디 \d+/,
  );
  await page.getByRole('button', { name: '메트로놈 정지', exact: true }).click();
});

test('start measure stays available in compact and tall-medium layouts', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feelmyrythm/');
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.getByRole('button', { name: '보면대 모드', exact: true })).toHaveCount(0);
  const focusButton = page.getByRole('button', { name: '집중 화면', exact: true });
  await expect(focusButton).toBeVisible();
  await expect(
    page.locator('.metronome-number').getByRole('img', { name: '현재 박 숫자' }),
  ).toBeVisible();
  await expect(page.locator('.metronome-number')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.metronome-number')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.metronome-heading .performance-context strong')).toHaveText('마디 1');
  await expect(page.locator('.metronome-heading__context')).toBeHidden();
  await expect(page.locator('.metronome-stage .performance-context')).toHaveCount(0);
  await expect(page.locator('.metronome-controls .count-in-button')).toHaveCount(0);
  const mobileTempo = page.locator('.metronome-stage .bpm-display--mobile');
  await expect(
    mobileTempo.getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' }),
  ).toHaveText('100');
  await expect(mobileTempo.getByText('4/4', { exact: true })).toBeVisible();
  await expect(mobileTempo).not.toContainText('BPM');
  await expect(page.locator('.metronome-tempo-setting')).toHaveCount(0);
  const bpmTrigger = mobileTempo.getByRole('button', { name: /^현재 BPM / });
  await bpmTrigger.click();
  const bpmDialog = page.getByRole('dialog', { name: 'BPM 직접 입력' });
  const bpmInput = bpmDialog.getByRole('spinbutton', { name: 'BPM', exact: true });
  await expect(bpmInput).toBeFocused();
  await bpmInput.fill('103');
  await bpmDialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(bpmTrigger).toHaveText('103');
  await expect(bpmTrigger).toBeFocused();
  const meterTrigger = mobileTempo.locator('.bpm-display__meter');
  await expect(meterTrigger).toHaveAccessibleName('현재 4/4박자, 눌러서 선택');
  await meterTrigger.click();
  const meterDialog = page.getByRole('dialog', { name: '박자 선택', exact: true });
  await expect(meterDialog).toBeVisible();
  expect(
    await meterDialog
      .getByRole('button', { name: /^\d+\/\d+박자$/ })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
  ).toEqual(['2/4박자', '3/4박자', '4/4박자', '5/4박자', '6/8박자', '9/8박자', '12/8박자']);
  await expect(meterDialog.getByRole('button', { name: '4/4박자', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await meterDialog.getByRole('button', { name: '12/8박자', exact: true }).click();
  await expect(meterDialog).toBeHidden();
  await expect(meterTrigger).toHaveAccessibleName('현재 12/8박자, 눌러서 선택');
  await expect(meterTrigger).toBeFocused();
  const mobileControls = page.locator('.metronome-mobile-controls');
  await expect(mobileControls).toBeVisible();
  expect(
    await mobileControls
      .locator('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
  ).toEqual(['BPM 5 낮추기', '메트로놈 재생', 'BPM 5 높이기', '탭 템포']);
  const mobileGeometry = await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>('.metronome-heading');
    const measure = heading?.querySelector<HTMLElement>('.performance-context');
    const headingActions = heading?.querySelector<HTMLElement>('.metronome-heading__actions');
    const number = document.querySelector<HTMLCanvasElement>('.metronome-number canvas');
    const beats = document.querySelector<HTMLElement>('.metronome-visualizer');
    const tempo = document.querySelector<HTMLElement>('.bpm-display--mobile');
    const tempoNumber = tempo?.querySelector<HTMLElement>('button[aria-label^="현재 BPM"] > span');
    const meter = tempo?.querySelector<HTMLElement>('.bpm-display__meter');
    const meterNumber = meter?.querySelector<HTMLElement>('span');
    const controls = document.querySelector<HTMLElement>('.metronome-mobile-controls');
    const rowButtons = [...(controls?.querySelectorAll<HTMLElement>('button') ?? [])];
    const main = document.querySelector<HTMLElement>('#main-content');
    if (
      !heading ||
      !measure ||
      !headingActions ||
      !number ||
      !beats ||
      !tempo ||
      !tempoNumber ||
      !meter ||
      !meterNumber ||
      !controls ||
      rowButtons.length !== 4 ||
      !main
    ) {
      throw new Error('Mobile metronome number and control row are missing');
    }
    const headingRect = heading.getBoundingClientRect();
    const measureRect = measure.getBoundingClientRect();
    const headingActionsRect = headingActions.getBoundingClientRect();
    const numberRect = number.getBoundingClientRect();
    const beatsRect = beats.getBoundingClientRect();
    const tempoRect = tempo.getBoundingClientRect();
    const tempoNumberRect = tempoNumber.getBoundingClientRect();
    const meterRect = meter.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const controlsStyle = getComputedStyle(controls);
    const rowRects = rowButtons.map((control) => control.getBoundingClientRect());
    const ratio = window.devicePixelRatio || 1;
    const baseline = (element: HTMLElement) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      element.append(probe);
      const y = probe.getBoundingClientRect().top;
      probe.remove();
      return y;
    };
    return {
      measureTop: measureRect.top,
      measureBottom: measureRect.bottom,
      measureLeft: measureRect.left,
      measureRight: measureRect.right,
      headingLeft: headingRect.left,
      headingActionsLeft: headingActionsRect.left,
      numberTop: numberRect.top,
      numberBottom: numberRect.bottom,
      numberHeight: numberRect.height,
      beatsTop: beatsRect.top,
      beatsBottom: beatsRect.bottom,
      tempoTop: tempoRect.top,
      tempoBottom: tempoRect.bottom,
      tempoNumberCenterDelta: Math.abs(
        tempoNumberRect.left + tempoNumberRect.width / 2 - (tempoRect.left + tempoRect.width / 2),
      ),
      meterClearsNumber:
        meterRect.left >= tempoNumberRect.right && meterRect.right <= tempoRect.right,
      tempoMeterBaselineDelta: Math.abs(baseline(tempoNumber) - baseline(meterNumber)),
      controlsTop: Math.min(...rowRects.map((rect) => rect.top)),
      controlsBottom: Math.max(...rowRects.map((rect) => rect.bottom)),
      controlRowCenterSpread:
        Math.max(...rowRects.map((rect) => rect.top + rect.height / 2)) -
        Math.min(...rowRects.map((rect) => rect.top + rect.height / 2)),
      controlsInOrder: rowRects
        .slice(1)
        .every((rect, index) => rect.left >= rowRects[index]!.right),
      transportCenter: (rowRects[0]!.left + rowRects[2]!.right) / 2,
      controlsCenter: controlsRect.left + controlsRect.width / 2,
      secondaryButtonsAreUnboxed: rowButtons
        .filter((button) => !button.classList.contains('play-button'))
        .every((button) => {
          const style = getComputedStyle(button);
          return style.borderWidth === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
        }),
      tapFontSize: parseFloat(getComputedStyle(rowButtons[3]!).fontSize),
      tapRight: rowRects[3]!.right,
      controlsContentRight: controlsRect.right - parseFloat(controlsStyle.paddingRight),
      mainTop: mainRect.top,
      mainBottom: mainRect.bottom,
      widthError: Math.abs(number.width - Math.round(numberRect.width * ratio)),
      heightError: Math.abs(number.height - Math.round(numberRect.height * ratio)),
    };
  });
  expect(mobileGeometry.measureTop).toBeGreaterThanOrEqual(mobileGeometry.mainTop);
  expect(mobileGeometry.measureBottom).toBeLessThanOrEqual(mobileGeometry.numberTop + 1);
  expect(Math.abs(mobileGeometry.measureLeft - mobileGeometry.headingLeft)).toBeLessThanOrEqual(1);
  expect(mobileGeometry.measureRight).toBeLessThanOrEqual(mobileGeometry.headingActionsLeft + 1);
  expect(mobileGeometry.numberHeight).toBeGreaterThanOrEqual(360);
  expect(mobileGeometry.numberTop).toBeGreaterThanOrEqual(mobileGeometry.mainTop);
  expect(mobileGeometry.numberBottom).toBeLessThanOrEqual(mobileGeometry.beatsTop + 1);
  expect(mobileGeometry.beatsBottom).toBeLessThanOrEqual(mobileGeometry.tempoTop + 1);
  expect(mobileGeometry.tempoBottom).toBeLessThanOrEqual(mobileGeometry.controlsTop + 1);
  expect(mobileGeometry.tempoNumberCenterDelta).toBeLessThanOrEqual(1);
  expect(mobileGeometry.meterClearsNumber).toBe(true);
  expect(mobileGeometry.tempoMeterBaselineDelta).toBeLessThanOrEqual(1);
  expect(mobileGeometry.controlsTop).toBeGreaterThanOrEqual(mobileGeometry.numberBottom);
  expect(mobileGeometry.controlsInOrder).toBe(true);
  expect(mobileGeometry.controlRowCenterSpread).toBeLessThanOrEqual(1);
  expect(
    Math.abs(mobileGeometry.transportCenter - mobileGeometry.controlsCenter),
  ).toBeLessThanOrEqual(1);
  expect(mobileGeometry.secondaryButtonsAreUnboxed).toBe(true);
  expect(mobileGeometry.tapFontSize).toBeLessThanOrEqual(12);
  expect(
    Math.abs(mobileGeometry.tapRight - mobileGeometry.controlsContentRight),
  ).toBeLessThanOrEqual(1);
  expect(mobileGeometry.controlsBottom).toBeLessThanOrEqual(mobileGeometry.mainBottom + 1);
  expect(mobileGeometry.widthError).toBeLessThanOrEqual(1);
  expect(mobileGeometry.heightError).toBeLessThanOrEqual(1);
  const beatCenterDelta = await page
    .locator('.metronome-visualizer canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Beat canvas context is missing');
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let top = canvas.height;
      let bottom = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (pixels[(y * canvas.width + x) * 4 + 3]! < 128) continue;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      if (bottom < top) throw new Error('Beat canvas has no visible circles');
      return Math.abs((top + bottom + 1) / 2 - canvas.height / 2) / window.devicePixelRatio;
    });
  expect(beatCenterDelta).toBeLessThanOrEqual(1);
  const screenProgress = page.locator('.metronome-screen-progress');
  const screenCanvas = screenProgress.locator('canvas');
  await expect(screenProgress).toHaveCount(1);
  await expect(screenProgress).toHaveCSS('position', 'fixed');
  await expect(screenProgress).toHaveCSS('z-index', '-1');
  await expect(screenProgress).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('.app-shell')).toHaveCSS('isolation', 'isolate');
  const navigationBackground = await page
    .locator('.bottom-nav')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(navigationBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.bottom-nav')).toHaveCSS('background-image', 'none');
  const assertContentProgressBounds = async () => {
    const geometry = await screenCanvas.evaluate(async (canvas: HTMLCanvasElement) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bounds = canvas.getBoundingClientRect();
      const navigation = document.querySelector<HTMLElement>('.bottom-nav');
      if (!navigation) throw new Error('Mobile navigation is missing');
      const navigationBounds = navigation.getBoundingClientRect();
      const rail = navigationBounds.width < window.innerWidth / 2;
      const ratio = window.devicePixelRatio || 1;
      return {
        insideAppShell: canvas.closest('.app-shell') !== null,
        insideMetronome: canvas.closest('.metronome-page') !== null,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        expectedLeft: rail ? navigationBounds.right : 0,
        expectedBottom: rail ? window.innerHeight : navigationBounds.top,
        viewportWidth: window.innerWidth,
        overlapsNavigation:
          bounds.left < navigationBounds.right &&
          bounds.right > navigationBounds.left &&
          bounds.top < navigationBounds.bottom &&
          bounds.bottom > navigationBounds.top,
        widthError: Math.abs(canvas.width - Math.round(bounds.width * ratio)),
        heightError: Math.abs(canvas.height - Math.round(bounds.height * ratio)),
      };
    });
    expect(geometry.insideAppShell).toBe(true);
    expect(geometry.insideMetronome).toBe(true);
    expect(geometry.left).toBe(geometry.expectedLeft);
    expect(geometry.top).toBe(0);
    expect(geometry.right).toBe(geometry.viewportWidth);
    expect(geometry.bottom).toBe(geometry.expectedBottom);
    expect(geometry.overlapsNavigation).toBe(false);
    expect(geometry.widthError).toBeLessThanOrEqual(1);
    expect(geometry.heightError).toBeLessThanOrEqual(1);
  };
  await assertContentProgressBounds();
  const controlsReceivePointer = await page.evaluate(() =>
    ['.metronome-mobile-controls .play-button', '.bottom-nav button'].every((selector) => {
      const button = document.querySelector<HTMLElement>(selector);
      if (!button) return false;
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      return hit !== null && button.contains(hit);
    }),
  );
  expect(controlsReceivePointer).toBe(true);
  await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
  const metronome = page.locator('.metronome-page');
  await expect(metronome).toHaveClass(/metronome-page--screen-progress/);
  await expect(metronome).toHaveAttribute('data-count-in', 'true');
  await expect(metronome).not.toHaveAttribute('data-count-in', 'true');
  await expect
    .poll(() =>
      screenCanvas.evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext('2d');
        const number = document.querySelector<HTMLCanvasElement>('.metronome-number canvas');
        const numberContext = number?.getContext('2d');
        if (!context || !number || !numberContext) {
          throw new Error('Screen progress or number canvas context is missing');
        }
        const rows = [2, Math.floor(canvas.height / 2), canvas.height - 2].map((y) => ({
          filled: [...context.getImageData(Math.floor(canvas.width * 0.25), y, 1, 1).data],
          clear: context.getImageData(Math.floor(canvas.width * 0.55), y, 1, 1).data[3],
        }));
        const numberBottom = numberContext.getImageData(0, number.height - 2, number.width, 1).data;
        return {
          fullHeightProgress: rows.every(
            (row) =>
              row.filled.every(
                (channel, index) => Math.abs(channel - [244, 122, 36, 77][index]!) <= 2,
              ) &&
              row.clear === 0 &&
              row.filled.every((channel, index) => channel === rows[0]!.filled[index]),
          ),
          numberHasNoBackground: numberBottom.every(
            (channel, index) => index % 4 !== 3 || channel === 0,
          ),
        };
      }),
    )
    .toEqual({ fullHeightProgress: true, numberHasNoBackground: true });
  await page.screenshot({ path: testInfo.outputPath('mobile-390-focus-normal.png') });
  await focusButton.click();
  await expect(metronome).toHaveClass(/metronome-page--focused/);
  await expect(metronome).not.toHaveClass(/metronome-page--fullscreen/);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  const exitFocus = page.getByRole('button', { name: '집중 화면 나가기', exact: true });
  await expect(exitFocus).toHaveAttribute('aria-pressed', 'true');
  await expect(metronome).toHaveAttribute('data-playing', 'true');
  await expect(metronome).not.toHaveAttribute('data-count-in', 'true');
  await expect(page.locator('.metronome-heading')).toBeHidden();
  await expect(page.locator('.bottom-nav')).toBeHidden();
  await expect(page.getByRole('button', { name: '세부 설정', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'BPM 5 낮추기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '탭 템포', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'BPM 5 높이기', exact: true })).toHaveCount(0);
  await expect(metronome.getByRole('button')).toHaveCount(4);
  await expect(bpmTrigger).toBeVisible();
  await expect(meterTrigger).toBeVisible();
  await expect(page.getByRole('button', { name: '메트로놈 정지', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-390-focus-active.png') });
  await bpmTrigger.click();
  await expect(bpmInput).toHaveValue('103');
  await bpmInput.fill('104');
  await page.keyboard.press('Escape');
  await expect(bpmDialog).toBeHidden();
  await expect(bpmTrigger).toHaveText('103');
  await expect(bpmTrigger).toBeFocused();
  await expect(metronome).toHaveClass(/metronome-page--focused/);
  await meterTrigger.click();
  await expect(meterDialog.getByRole('button', { name: '12/8박자', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(meterDialog).toBeHidden();
  await expect(meterTrigger).toBeFocused();
  await expect(metronome).toHaveClass(/metronome-page--focused/);
  await exitFocus.click();
  await expect(metronome).not.toHaveClass(/metronome-page--focused/);
  await expect(focusButton).toBeFocused();
  await expect(metronome).toHaveAttribute('data-playing', 'true');
  await expect(metronome).not.toHaveAttribute('data-count-in', 'true');
  await page.keyboard.press('Space');
  await expect(metronome).toHaveClass(/metronome-page--focused/);
  await page.keyboard.press('Escape');
  await expect(metronome).not.toHaveClass(/metronome-page--focused/);
  await expect(focusButton).toBeFocused();
  await expect(metronome).toHaveAttribute('data-playing', 'true');
  await expect(metronome).not.toHaveAttribute('data-count-in', 'true');
  await page.getByRole('button', { name: '메트로놈 정지', exact: true }).click();
  const compactSettings = page.getByRole('button', { name: '세부 설정' });
  await expect(compactSettings).toBeVisible();
  await compactSettings.click();
  const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
  const dialogStartMeasure = dialog.getByRole('spinbutton', { name: '시작 마디' });
  await expect(dialogStartMeasure).toBeVisible();
  await dialogStartMeasure.fill('4');
  await expect(dialogStartMeasure).toHaveValue('4');
  await expect(dialog.getByRole('button', { name: /^현재 BPM / })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '박자', exact: true }).selectOption('3/4');
  await dialog.getByRole('button', { name: '닫기' }).click();
  await expect(mobileTempo.getByText('3/4', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 768, height: 1_024 });
  await expect(page.locator('.metronome-settings')).toBeVisible();
  await expect(mobileTempo).toBeVisible();
  await expect(
    page.locator('.metronome-settings').getByRole('combobox', { name: '박자', exact: true }),
  ).toHaveValue('3/4');
  await expect(page.getByRole('button', { name: '세부 설정' })).toBeHidden();
  await expect(
    page.locator('.metronome-settings').getByRole('button', { name: '예비박', exact: true }),
  ).toBeVisible();
  const inlineStartMeasure = page.locator('.quick-settings').getByRole('spinbutton', {
    name: '시작 마디',
  });
  await expect(inlineStartMeasure).toBeVisible();
  await expect(inlineStartMeasure).toHaveValue('4');
  await expect(screenCanvas).toBeVisible();
  await assertContentProgressBounds();

  await page.setViewportSize({ width: 768, height: 600 });
  await assertContentProgressBounds();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  await assertContentProgressBounds();
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('font-size');
  });

  await page.setViewportSize({ width: 840, height: 900 });
  await expect(screenProgress).toHaveCount(0);
  await expect(metronome).not.toHaveClass(/metronome-page--screen-progress/);
  await page.getByRole('button', { name: '보면대 모드' }).click();
  await expect(metronome).toHaveClass(/metronome-page--fullscreen/);
  await expect(screenProgress).toHaveCount(0);
  await expect(metronome).not.toHaveClass(/metronome-page--screen-progress/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '나가기', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(screenCanvas).toBeVisible();
  await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
  await expect(metronome).toHaveAttribute('data-playing', 'true');
  const reducedMotionHasFill = await screenCanvas.evaluate(async (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screen progress canvas context is missing');
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rows = [2, Math.floor(canvas.height / 2), canvas.height - 2];
      if (rows.some((y) => context.getImageData(1, y, 1, 1).data[3]! > 0)) return true;
    }
    return false;
  });
  expect(reducedMotionHasFill).toBe(false);
  const mobileMenu = page.getByRole('navigation', { name: '모바일 주요 메뉴' });
  await mobileMenu.getByRole('button', { name: '더보기', exact: true }).click();
  const more = page.getByRole('dialog', { name: '더보기', exact: true });
  await expect(more).toBeVisible();
  await more.getByRole('button', { name: '닫기', exact: true }).click();
  await mobileMenu.getByRole('link', { name: '악보', exact: true }).click();
  await expect(page).toHaveURL(/\/scores$/);
  await expect(page.getByRole('heading', { name: '악보', exact: true })).toBeVisible();
  await expect(screenProgress).toHaveCount(0);
  await expect(page.locator('.bottom-nav')).toHaveCSS('background-color', navigationBackground);
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

test('mobile tap pad separates entry from measured taps and restores focus', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-09-29T00:00:00Z') });
  await page.goto('/feelmyrythm/');
  const launcher = page.getByRole('button', { name: '탭 템포', exact: true });
  const bpm = page.locator('.bpm-display > button[aria-label^="현재 BPM"] > span');
  await expect(bpm).toHaveText('100');
  await page.clock.pauseAt(new Date('2026-09-29T00:01:00Z'));
  await launcher.click();
  await page.clock.runFor(32);

  const panel = page.locator('.tap-tempo-panel');
  const pad = panel.getByRole('button', { name: '박자에 맞춰 탭', exact: true });
  const close = panel.getByRole('button', { name: '탭 템포 닫기', exact: true });
  await expect(panel).toBeVisible();
  await expect(pad).toBeFocused();
  await expect(pad).toHaveJSProperty('tagName', 'BUTTON');
  await expect(pad).not.toHaveAttribute('data-feedback');
  await expect(bpm).toHaveText('100');
  await expect(page.locator('.metronome-mobile-controls')).toBeHidden();
  await expect(page.getByRole('button', { name: '메트로놈 재생', exact: true })).toHaveCount(0);
  const panelGeometry = await panel.evaluate((element) => {
    const pad = element.querySelector<HTMLElement>('.tap-tempo-pad');
    const close = element.querySelector<HTMLElement>('[aria-label="탭 템포 닫기"]');
    const controls = element.closest<HTMLElement>('.metronome-controls');
    const main = element.closest<HTMLElement>('#main-content');
    if (!pad || !close || !controls || !main) throw new Error('Tap pad regions are missing');
    const panel = element.getBoundingClientRect();
    const padRect = pad.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const controlsStyle = getComputedStyle(controls);
    return {
      siblings: pad.parentElement === close.parentElement,
      panelWidth: panel.width,
      controlsContentWidth:
        controlsRect.width -
        parseFloat(controlsStyle.paddingLeft) -
        parseFloat(controlsStyle.paddingRight),
      padWidth: padRect.width,
      padHeight: padRect.height,
      closeWidth: closeRect.width,
      closeHeight: closeRect.height,
      closeInUpperRight:
        closeRect.left >= panel.left + panel.width / 2 &&
        closeRect.right <= panel.right &&
        closeRect.top >= panel.top &&
        closeRect.top + closeRect.height / 2 <= panel.top + panel.height / 2,
      panelBottom: panel.bottom,
      mainBottom: main.getBoundingClientRect().bottom,
    };
  });
  expect(panelGeometry.siblings).toBe(true);
  expect(
    Math.abs(panelGeometry.panelWidth - panelGeometry.controlsContentWidth),
  ).toBeLessThanOrEqual(1);
  expect(panelGeometry.padWidth).toBeGreaterThanOrEqual(240);
  expect(panelGeometry.padHeight).toBeGreaterThanOrEqual(100);
  expect(panelGeometry.closeWidth).toBeGreaterThanOrEqual(48);
  expect(panelGeometry.closeHeight).toBeGreaterThanOrEqual(48);
  expect(panelGeometry.closeInUpperRight).toBe(true);
  expect(panelGeometry.panelBottom).toBeLessThanOrEqual(panelGeometry.mainBottom + 1);
  await page.screenshot({ path: testInfo.outputPath('mobile-390-tempo-background-tap-pad.png') });

  await pad.click();
  await expect(pad).toHaveAttribute('data-feedback', '다시 탭');
  await expect(bpm).toHaveText('100');
  await page.clock.runFor(500);
  await pad.click();
  await expect(pad).toHaveAttribute('data-feedback', '2회');
  await expect(bpm).toHaveText('120');
  await page.clock.runFor(800);
  await pad.click();
  await page.clock.runFor(400);
  await pad.click();
  await expect(pad).toHaveAttribute('data-feedback', '4회');
  // The existing tap algorithm uses the median of recent intervals: 500, 800, 400 ms.
  await expect(bpm).toHaveText('120');

  await close.click();
  await page.clock.runFor(32);
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(bpm).toHaveText('120');
  await launcher.press('Enter');
  await page.clock.runFor(32);
  await expect(pad).toBeFocused();
  await expect(pad).not.toHaveAttribute('data-feedback');
  await pad.press('Space');
  await expect(pad).toHaveAttribute('data-feedback', '다시 탭');
  await expect(bpm).toHaveText('120');
  await page.keyboard.press('Escape');
  await page.clock.runFor(32);
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(bpm).toHaveText('120');

  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.clock.runFor(32);
  await expect(
    page.locator('.metronome-stage .bpm-display > button[aria-label^="현재 BPM"] > span'),
  ).toHaveText('120');
  const desktopTap = page
    .locator('.bpm-steppers')
    .getByRole('button', { name: '탭 템포', exact: true });
  await expect(desktopTap).toBeVisible();
  await desktopTap.click();
  await expect(desktopTap).toHaveAttribute('data-feedback', /다시 탭|\d+회/);
  await expect(panel).toBeHidden();
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

    for (const name of ['메트로놈 재생', 'BPM 5 낮추기', '탭 템포', 'BPM 5 높이기']) {
      const target = page.getByRole('button', { name, exact: true });
      await expect(target).toBeVisible();
      const bounds = await target.boundingBox();
      expect(bounds, `${viewport.width}px ${name} target has geometry`).not.toBeNull();
      expect(bounds!.width, `${viewport.width}px ${name} target width`).toBeGreaterThanOrEqual(48);
      expect(bounds!.height, `${viewport.width}px ${name} target height`).toBeGreaterThanOrEqual(
        48,
      );
    }
    const controlRow = await page.locator('.metronome-mobile-controls').evaluate((element) => {
      const buttons = [...element.querySelectorAll('button')];
      const rects = buttons.map((button) => button.getBoundingClientRect());
      const row = element.getBoundingClientRect();
      return {
        names: buttons.map((button) => button.getAttribute('aria-label')),
        centerSpread:
          Math.max(...rects.map((rect) => rect.top + rect.height / 2)) -
          Math.min(...rects.map((rect) => rect.top + rect.height / 2)),
        leftToRight: rects.slice(1).every((rect, index) => rect.left >= rects[index]!.right),
        transportCenterError: Math.abs(
          (rects[0]!.left + rects[2]!.right) / 2 - (row.left + row.width / 2),
        ),
      };
    });
    expect(controlRow.names).toEqual(['BPM 5 낮추기', '메트로놈 재생', 'BPM 5 높이기', '탭 템포']);
    expect(controlRow.centerSpread, `${viewport.width}px one-row controls`).toBeLessThanOrEqual(1);
    expect(controlRow.leftToRight, `${viewport.width}px control order`).toBe(true);
    expect(
      controlRow.transportCenterError,
      `${viewport.width}px centered transport`,
    ).toBeLessThanOrEqual(1);
    await expect(page.locator('.metronome-controls .count-in-button')).toHaveCount(0);
    const settings = page.getByRole('button', { name: '세부 설정' });
    const usesSettingsDialog = await settings.isVisible();
    if (usesSettingsDialog) await settings.click();
    const settingsRegion = usesSettingsDialog
      ? page.getByRole('dialog', { name: '메트로놈 세부 설정' })
      : page.locator('.metronome-settings');
    const countIn = settingsRegion.getByRole('button', { name: '예비박', exact: true });
    await expect(countIn).toBeVisible();
    const countInBounds = await countIn.boundingBox();
    expect(countInBounds, `${viewport.width}px settings count-in target`).not.toBeNull();
    expect(countInBounds!.width).toBeGreaterThanOrEqual(48);
    expect(countInBounds!.height).toBeGreaterThanOrEqual(48);
    const visibleCountInText = await countIn.evaluate(
      (element) => (element as HTMLElement).innerText,
    );
    expect(visibleCountInText).toContain('예비');
    expect(visibleCountInText).toMatch(/켬|끔/);
    await expect(settingsRegion.getByRole('button', { name: /^현재 BPM / })).toHaveCount(0);
    if (usesSettingsDialog) {
      await page.keyboard.press('Escape');
      await expect(settings).toBeFocused();
    }
    const tempo = page
      .locator('.bpm-display--mobile')
      .getByRole('button', { name: '현재 BPM 100, 눌러서 직접 입력' });
    await expect(tempo).toBeVisible();
    const tempoBounds = await tempo.boundingBox();
    expect(tempoBounds, `${viewport.width}px main BPM target`).not.toBeNull();
    expect(tempoBounds!.width).toBeGreaterThanOrEqual(48);
    expect(tempoBounds!.height).toBeGreaterThanOrEqual(48);

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
    expect(retryBounds).not.toBeNull();
    expect(retryBounds!.height).toBeGreaterThanOrEqual(48);
    await expect(page.locator('.metronome-stage .bpm-display--mobile')).toBeVisible();
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
    const number = page.locator('.metronome-number');
    await expect(main).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(number).toBeVisible();
    const tempo = page.locator('.metronome-stage .bpm-display--mobile');
    await expect(tempo).toBeVisible();
    const mainRect = await main.boundingBox();
    const navRect = await nav.boundingBox();
    const numberRect = await number.boundingBox();
    const beatsRect = await page.locator('.metronome-visualizer').boundingBox();
    const tempoRect = await tempo.boundingBox();
    const controlsRect = await page.locator('.metronome-mobile-controls').boundingBox();
    expect(mainRect, `${viewport.width}x${viewport.height} main`).not.toBeNull();
    expect(navRect, `${viewport.width}x${viewport.height} nav`).not.toBeNull();
    expect(numberRect, `${viewport.width}x${viewport.height} number`).not.toBeNull();
    expect(beatsRect, `${viewport.width}x${viewport.height} beats`).not.toBeNull();
    expect(tempoRect, `${viewport.width}x${viewport.height} tempo`).not.toBeNull();
    expect(controlsRect, `${viewport.width}x${viewport.height} controls`).not.toBeNull();
    const initialGeometry = {
      numberStartsVisible:
        numberRect!.y >= mainRect!.y - 1 && numberRect!.y < mainRect!.y + mainRect!.height,
      numberClearsBeats: numberRect!.y + numberRect!.height <= beatsRect!.y + 1,
      beatsClearTempo: beatsRect!.y + beatsRect!.height <= tempoRect!.y + 1,
      tempoClearsControls: tempoRect!.y + tempoRect!.height <= controlsRect!.y + 1,
      navHeight: navRect!.height,
      navStartsAtMainEnd: Math.abs(navRect!.y - (mainRect!.y + mainRect!.height)),
    };
    expect(initialGeometry.numberStartsVisible, `${viewport.width}x${viewport.height} number`).toBe(
      true,
    );
    expect(
      initialGeometry.numberClearsBeats,
      `${viewport.width}x${viewport.height} beat separation`,
    ).toBe(true);
    expect(
      initialGeometry.beatsClearTempo,
      `${viewport.width}x${viewport.height} tempo separation`,
    ).toBe(true);
    expect(
      initialGeometry.tempoClearsControls,
      `${viewport.width}x${viewport.height} control separation`,
    ).toBe(true);
    expect(initialGeometry.navHeight).toBeLessThanOrEqual(viewport.width <= 359 ? 88 : 96);
    expect(initialGeometry.navStartsAtMainEnd).toBeLessThanOrEqual(1);

    for (const selector of [
      '.bpm-display--mobile > button[aria-label^="현재 BPM"]',
      '.bpm-display__meter',
      '.metronome-mobile-controls [aria-label="BPM 5 낮추기"]',
      '.play-button',
      '.metronome-mobile-controls [aria-label="BPM 5 높이기"]',
      '.tap-button',
      '.metronome-heading__short-settings',
    ]) {
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

    const tapLauncher = page.getByRole('button', { name: '탭 템포', exact: true });
    await tapLauncher.click();
    for (const name of ['박자에 맞춰 탭', '탭 템포 닫기']) {
      const control = page.getByRole('button', { name, exact: true });
      await control.focus();
      await expect(control).toBeFocused();
      await expect
        .poll(() =>
          control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const main = document.querySelector('#main-content')?.getBoundingClientRect();
            const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
            return Boolean(
              main &&
              nav &&
              rect.width >= 48 &&
              rect.height >= 48 &&
              rect.left >= main.left &&
              rect.right <= main.right &&
              rect.top >= main.top &&
              rect.bottom <= Math.min(main.bottom, nav.top) + 1,
            );
          }),
        )
        .toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.tap-tempo-panel')).toBeHidden();
    await expect(tapLauncher).toBeFocused();

    const settings = page.getByRole('button', { name: '세부 설정' });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
    const countIn = dialog.getByRole('button', { name: '예비박', exact: true });
    await countIn.focus();
    await expect(countIn).toBeFocused();
    await expect
      .poll(() =>
        countIn.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const dialog = element.closest('[role="dialog"]')?.getBoundingClientRect();
          return Boolean(
            dialog &&
            rect.width >= 48 &&
            rect.height >= 48 &&
            rect.left >= dialog.left &&
            rect.right <= dialog.right &&
            rect.top >= dialog.top &&
            rect.bottom <= Math.min(dialog.bottom, window.innerHeight),
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press('Space');
    await expect(countIn).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await expect(settings).toBeFocused();

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

  const tempo = page.locator('.bpm-display--mobile').getByRole('button', {
    name: /^현재 BPM \d+, 눌러서 직접 입력$/,
  });
  await expect(tempo).toHaveText('100');
  await expect(page.locator('.metronome-tempo-setting')).toHaveCount(0);
  await tempo.click();
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

  await input.fill('128');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tempo).toHaveText('128');
  await expect(tempo).toBeFocused();
  await tempo.click();
  await expect(input).toHaveValue('128');
  await input.fill('132');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tempo).toHaveText('128');
  await expect(tempo).toBeFocused();

  await context.close();
});
