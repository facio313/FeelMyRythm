import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

for (const countIn of [false, true]) {
  test(`automatically resumes after a fermata and breath with reentry count-in ${countIn ? 'on' : 'off'}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('fmr.countInEnabled', 'false');
      localStorage.setItem('fmr.countInMeasures', '1');
    });
    await page.goto('/feelmyrythm/editor');
    await expect(page.getByRole('heading', { name: '템포맵 편집기' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'tempo-expressions.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          id: 'expression-playback',
          repertoireItemId: 'local',
          revision: 0,
          totalMeasures: 6,
          countIn: { measures: 1, useSectionMeter: true },
          jumps: [],
          sections: [
            {
              id: 'single-section',
              label: '구간을 나누지 않는 연주',
              startMeasure: 1,
              endMeasure: 6,
              bpm: 120,
              beatUnit: 'quarter',
              timeSignature: { num: 4, denom: 4 },
            },
          ],
          measureExpressions: [
            { measure: 2, tempoChange: { type: 'rit', targetBpm: 60, endMeasure: 3 } },
            {
              measure: 3,
              fermata: { beat: 2, extraBeats: 1 },
              breath: { durationSec: 1.5, countIn },
            },
            { measure: 4, tempoChange: { type: 'aTempo', targetBpm: 120 } },
          ],
        }),
      ),
    });
    await expect(page.getByText('템포맵을 가져왔습니다.', { exact: true })).toBeVisible();
    await expect(page.locator('.tempo-block')).toHaveCount(1);
    await page
      .locator('.editor-save-bar')
      .getByRole('button', { name: '저장', exact: true })
      .click();
    await expect(page.getByText('템포맵을 저장했습니다.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '메트로놈에서 열기' }).click();
    await page.getByRole('button', { name: '메트로놈 재생', exact: true }).click();
    const phase = page.locator('.performance-context');
    await expect(phase).toContainText('페르마타');
    await expect(phase.locator('strong')).toHaveText('마디 3');
    await expect(phase).toContainText('숨 고르기');
    await expect(page.locator('.fmr-count-in')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '메트로놈 정지', exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        page.locator('.metronome-screen-progress canvas').evaluate((canvas) => {
          const element = canvas as HTMLCanvasElement;
          const context = element.getContext('2d');
          if (!context) throw new Error('Progress canvas context is unavailable');
          const pixels = context.getImageData(0, 0, element.width, element.height).data;
          return pixels.some((value, index) => index % 4 === 3 && value !== 0);
        }),
      )
      .toBe(false);
    if (countIn) {
      await expect(phase).toContainText('마디 4 · 예비박');
      await expect(page.locator('.fmr-count-in')).toHaveCount(1);
      await expect(page.locator('.fmr-count-in__destination')).toHaveText('4마디에서 시작');
      await expect(page.locator('.fmr-count-in__value')).toHaveText('0');
    }
    await expect(phase.locator('strong')).toHaveText('마디 4', countIn ? {} : { timeout: 2500 });
    await expect(page.locator('.fmr-count-in')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '현재 BPM 120, 눌러서 직접 입력' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '현재 4/4박자, 눌러서 선택' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: '메트로놈 재생', exact: true })).toBeVisible();
  });
}
