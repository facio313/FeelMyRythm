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
  { name: 'effective-256', width: 256, height: 568 },
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'phone-375', width: 375, height: 667 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-430', width: 430, height: 932 },
  { name: 'phone-landscape', width: 667, height: 375 },
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
            expect(playRect).not.toBeNull();
            expect(playRect!.y + playRect!.height).toBeLessThanOrEqual(viewport.height + 1);

            if (viewport.height <= 539) {
              const settings = page.getByRole('button', { name: '세부 설정' });
              await expect(settings).toBeVisible();
              await settings.click();
              const dialog = page.getByRole('dialog', { name: '메트로놈 세부 설정' });
              await expect(dialog).toBeVisible();
              await expect(dialog.getByRole('slider')).toBeVisible();
              await expect(dialog.getByRole('combobox')).toBeVisible();
              await dialog.getByRole('button', { name: '닫기' }).click();
            }
          }
        });
      }
    });
  });
}

test('coarse pointer, large text, keyboard and reduced motion keep controls usable', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
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
  const meter = page.getByRole('combobox', { name: '박자' });
  await expect(meter).toBeVisible();
  await expect(meter).toHaveCSS('min-height', '48px');
  const selectBox = await meter.boundingBox();
  expect(selectBox).not.toBeNull();
  expect(selectBox!.height).toBeGreaterThanOrEqual(48);
  const playAnimation = await page
    .locator('.play-button')
    .evaluate((element) => getComputedStyle(element, '::after').animationName);
  expect(playAnimation).toBe('none');
  await context.close();
});
