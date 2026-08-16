import { expect, test } from '@playwright/test';

const scoreSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="white"/>
  <g stroke="#111" stroke-width="3">
    <line x1="80" y1="120" x2="720" y2="120"/>
    <line x1="80" y1="160" x2="720" y2="160"/>
    <line x1="80" y1="200" x2="720" y2="200"/>
    <line x1="80" y1="240" x2="720" y2="240"/>
    <line x1="80" y1="280" x2="720" y2="280"/>
  </g>
</svg>`;

const remoteRepertoireId = '55555555-5555-4555-8555-555555555555';
const remoteScoreId = '66666666-6666-4666-8666-666666666666';
const remoteAuthState = {
  tokens: {
    accessToken: 'scores-e2e-access',
    refreshToken: 'scores-e2e-refresh',
    tokenType: 'bearer',
  },
  user: {
    id: 'leader-omr',
    email: 'omr@example.test',
    displayName: 'OMR Leader',
    emailVerifiedAt: '2026-08-15T00:00:00Z',
    hasPassword: true,
  },
};

test('shows a recoverable error when a PDF cannot be rendered', async ({ page }) => {
  await page.goto('/feelmyrythm/scores');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('not-a-pdf'),
  });

  await expect(page.getByRole('alert')).toContainText('PDF 페이지를 표시하지 못했습니다.');
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
});

test('previews a persistent Audiveris draft and saves it with its pinned map revision', async ({
  page,
}) => {
  let jobPolls = 0;
  let savedBody: Record<string, unknown> | undefined;
  const regions = [
    { page: 1, measureNumber: 1, rect: { x: 0.1, y: 0.2, w: 0.35, h: 0.12 } },
    { page: 1, measureNumber: 2, rect: { x: 0.5, y: 0.2, w: 0.35, h: 0.12 } },
  ];
  await page.addInitScript((session) => {
    localStorage.setItem('fmr.auth.session.v1', JSON.stringify(session));
  }, remoteAuthState);
  await page.addInitScript(() => {
    class AnnotationSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly OPEN = 1;
      readyState = 0;

      constructor(readonly url: string) {
        super();
        Object.assign(window, { __fmrAnnotationSocket: this });
        queueMicrotask(() => {
          this.readyState = AnnotationSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(raw: string) {
        const message = JSON.parse(raw) as { type: string; payload: { repertoireId?: string } };
        if (message.type !== 'JOIN_ANNOTATIONS') return;
        queueMicrotask(() => {
          this.serverMessage({
            type: 'ANNOTATION_JOINED',
            payload: { repertoireId: message.payload.repertoireId, userId: 'leader-omr' },
          });
          this.serverMessage({
            type: 'ANNOTATION_SNAPSHOT',
            payload: { repertoireId: message.payload.repertoireId, annotations: [] },
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      serverMessage(message: unknown) {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify(message),
          }),
        );
      }
    }
    Object.assign(window, { WebSocket: AnnotationSocket });
  });
  await page.route('**/feelmyrythm/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/feelmyrythm/api', '');
    const score = {
      id: remoteScoreId,
      repertoireId: remoteRepertoireId,
      kind: 'full',
      instrument: '',
      filename: 'omr.svg',
      contentType: 'image/svg+xml',
      sizeBytes: scoreSvg.length,
      uploadStatus: 'ready',
      createdAt: '2026-08-15T00:00:00Z',
      updatedAt: '2026-08-15T00:00:00Z',
    };
    const job = {
      id: 'omr-job-1',
      scoreId: remoteScoreId,
      requestedById: remoteAuthState.user.id,
      expectedMeasureMapRevision: 0,
      status: jobPolls > 0 ? 'succeeded' : 'running',
      regions: jobPolls > 0 ? regions : [],
      warnings: jobPolls > 0 ? ['모든 마디를 확인하세요.'] : [],
      error: null,
      createdAt: '2026-08-15T00:00:00Z',
      updatedAt: '2026-08-15T00:00:01Z',
    };

    if (request.method() === 'GET' && path === `/repertoire/${remoteRepertoireId}/scores`) {
      await route.fulfill({ json: [score] });
      return;
    }
    if (request.method() === 'GET' && path === `/repertoire/${remoteRepertoireId}/access`) {
      await route.fulfill({ json: { role: 'leader' } });
      return;
    }
    if (request.method() === 'GET' && path === `/repertoire/${remoteRepertoireId}/tempomap`) {
      const data = {
        id: 'omr-map',
        repertoireItemId: remoteRepertoireId,
        revision: 1,
        totalMeasures: 2,
        sections: [
          {
            id: 'omr-section',
            startMeasure: 1,
            endMeasure: 2,
            timeSignature: { num: 4, denom: 4 },
            bpm: 100,
            beatUnit: 'quarter',
          },
        ],
        jumps: [],
        countIn: { measures: 1, useSectionMeter: true },
      };
      await route.fulfill({
        json: {
          id: data.id,
          repertoireId: remoteRepertoireId,
          revision: 1,
          data,
          createdById: remoteAuthState.user.id,
          createdAt: '2026-08-15T00:00:00Z',
        },
      });
      return;
    }
    if (request.method() === 'GET' && path === `/scores/${remoteScoreId}`) {
      await route.fulfill({ json: score });
      return;
    }
    if (request.method() === 'GET' && path === `/scores/${remoteScoreId}/download`) {
      await route.fulfill({
        json: {
          url: 'http://127.0.0.1:4173/omr-score.svg',
          expiresAt: '2026-08-15T01:00:00Z',
        },
      });
      return;
    }
    if (request.method() === 'GET' && path === `/scores/${remoteScoreId}/measure-map`) {
      await route.fulfill({ status: 404, json: { detail: 'measure map not found' } });
      return;
    }
    if (
      request.method() === 'GET' &&
      (path === `/repertoire/${remoteRepertoireId}/annotations` ||
        path === `/repertoire/${remoteRepertoireId}/logs`)
    ) {
      await route.fulfill({ json: [] });
      return;
    }
    if (request.method() === 'POST' && path === `/scores/${remoteScoreId}/omr-drafts`) {
      await route.fulfill({ status: 202, json: job });
      return;
    }
    if (request.method() === 'GET' && path === '/omr-drafts/omr-job-1') {
      jobPolls += 1;
      await route.fulfill({ json: { ...job, status: 'succeeded', regions } });
      return;
    }
    if (request.method() === 'PUT' && path === `/scores/${remoteScoreId}/measure-map`) {
      savedBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          id: 'saved-omr-map',
          scoreId: remoteScoreId,
          revision: 1,
          regions,
          measureNumberOffset: 0,
          updatedAt: '2026-08-15T00:00:02Z',
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: `${request.method()} ${path}` } });
  });
  await page.route('**/omr-score.svg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: scoreSvg }),
  );

  await page.goto(`/feelmyrythm/repertoire/${remoteRepertoireId}/scores/${remoteScoreId}`);
  await expect(page.getByText('Audiveris OMR 초안')).toBeVisible();
  await expect(page.getByText('공동 필기 실시간 연결됨')).toBeVisible();
  await page.evaluate(
    ({ repertoireId, scoreId }) => {
      const socket = (
        window as unknown as {
          __fmrAnnotationSocket: { serverMessage: (message: unknown) => void };
        }
      ).__fmrAnnotationSocket;
      socket.serverMessage({
        type: 'ANNOTATION_EVENT',
        payload: {
          eventId: 'live-annotation-upsert',
          repertoireId,
          operation: 'upsert',
          annotationId: 'live-annotation-1',
          revision: 1,
          scope: 'project',
          authorId: 'remote-member',
          annotation: {
            id: 'live-annotation-1',
            scoreId,
            authorId: 'remote-member',
            scope: 'project',
            revision: 1,
            data: {
              kind: 'text',
              page: 1,
              payload: { x: 0.5, y: 0.3, text: '실시간 포르테', anchorType: 'page' },
            },
            createdAt: '2026-08-15T00:00:00Z',
            updatedAt: '2026-08-15T00:00:01Z',
          },
        },
      });
    },
    { repertoireId: remoteRepertoireId, scoreId: remoteScoreId },
  );
  await expect(page.getByText('실시간 포르테')).toBeVisible();
  await page.evaluate((repertoireId) => {
    const socket = (
      window as unknown as {
        __fmrAnnotationSocket: { serverMessage: (message: unknown) => void };
      }
    ).__fmrAnnotationSocket;
    socket.serverMessage({
      type: 'ANNOTATION_EVENT',
      payload: {
        eventId: 'live-annotation-delete',
        repertoireId,
        operation: 'delete',
        annotationId: 'live-annotation-1',
        revision: 1,
        scope: 'project',
        authorId: 'remote-member',
        annotation: null,
      },
    });
  }, remoteRepertoireId);
  await expect(page.getByText('실시간 포르테')).toHaveCount(0);
  await page.getByRole('button', { name: 'OMR 초안 생성' }).click();
  await expect(page.getByText('2개 마디 영역을 인식했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '초안 영역 미리보기' }).click();
  await expect(page.locator('.measure-region--omr-draft')).toHaveCount(2);
  await page.getByRole('button', { name: '초안을 마디 맵으로 저장' }).click();
  await expect(page.getByText(/2마디 매핑됨/)).toBeVisible();
  expect(savedBody).toMatchObject({ expectedRevision: 0, regions });
});

test('maps a score, preserves canonical measure across parts, and persists practice-aware pen notes', async ({
  page,
}) => {
  await page.goto('/feelmyrythm/scores');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'violin.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(scoreSvg),
  });

  await expect(page.locator('.score-stage')).toBeVisible();
  const scoreUrl = page.url();
  const scoreId = scoreUrl.match(/\/scores\/([^?]+)/)?.[1];
  expect(scoreId).toBeTruthy();

  await page.getByRole('button', { name: '마디 매핑' }).click();
  const stage = page.locator('.score-page-surface');
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const left = stageBox!.x + stageBox!.width * 0.12;
  const right = stageBox!.x + stageBox!.width * 0.88;
  const top = stageBox!.y + stageBox!.height * 0.15;
  const bottom = stageBox!.y + stageBox!.height * 0.42;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom);
  await page.mouse.up();
  await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  await page.getByRole('button', { name: '시스템 완료' }).click();
  await expect(page.getByText('2마디 매핑됨')).toBeVisible();

  await page.getByRole('button', { name: '펜', exact: true }).click();
  await page.getByLabel('프로젝트 공유').check();
  await page.mouse.move(left + 24, top + 24);
  await page.mouse.down();
  await page.mouse.move(left + 120, top + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.annotation-pen--project')).toHaveCount(1);

  await page.mouse.move(left + 40, top + 90);
  await page.mouse.down();
  await page.mouse.move(left + 140, top + 110, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.annotation-pen--project')).toHaveCount(2);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '필기 삭제: 펜 스트로크' }).first().click();
  await expect(page.locator('.annotation-pen--project')).toHaveCount(1);

  await page.getByText('악보 정보 · 번호 보정').click();
  await page.getByLabel('악보 종류').selectOption('part');
  await page.getByLabel('악기').fill('Violin 1');
  await page.getByLabel('공통 마디 번호 오프셋').fill('10');
  await page.getByRole('button', { name: '정보 저장' }).click();
  await expect(page.getByRole('tab', { name: 'Violin 1' })).toBeVisible();

  await page.getByRole('button', { name: '보기', exact: true }).click();
  const firstMeasureButton = page.getByRole('button', { name: '11마디' });
  await firstMeasureButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('현재 마디')).toHaveValue('11');

  await page.getByRole('button', { name: '텍스트', exact: true }).click();
  await page.getByLabel('필기 내용').fill('shared bowing');
  await page.getByRole('button', { name: '현재 마디 중앙에 추가' }).click();
  await expect(page.locator('.annotation-text')).toContainText('shared bowing');
  await page.getByRole('button', { name: '12마디' }).click();
  await page.getByLabel('필기 내용').fill('second phrase');
  await page.getByRole('button', { name: '현재 마디 중앙에 추가' }).click();
  await expect(page.locator('.annotation-text')).toHaveCount(2);
  await page.getByRole('button', { name: '11마디' }).click();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'cello.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(scoreSvg),
  });
  await expect(page.getByRole('tab', { name: 'cello.svg' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const secondScoreImage = page.locator('.score-image');
  await expect
    .poll(() =>
      secondScoreImage.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(secondScoreImage).toHaveAttribute('draggable', 'false');
  await page.getByRole('button', { name: '마디 매핑' }).click();
  const secondStage = page.locator('.score-page-surface');
  const secondBox = await secondStage.boundingBox();
  expect(secondBox).not.toBeNull();
  const secondLeft = secondBox!.x + secondBox!.width * 0.12;
  const secondRight = secondBox!.x + secondBox!.width * 0.88;
  const secondTop = secondBox!.y + secondBox!.height * 0.15;
  const secondBottom = secondBox!.y + secondBox!.height * 0.42;
  await page.mouse.move(secondLeft, secondTop);
  await page.mouse.down();
  await page.mouse.move(secondRight, secondBottom);
  await page.mouse.up();
  await page.mouse.click((secondLeft + secondRight) / 2, (secondTop + secondBottom) / 2);
  await page.getByRole('button', { name: '시스템 완료' }).click();
  await page.getByText('악보 정보 · 번호 보정').click();
  await page.getByLabel('악기').fill('Cello');
  await page.getByLabel('공통 마디 번호 오프셋').fill('10');
  await page.getByRole('button', { name: '정보 저장' }).click();
  await page.getByRole('button', { name: '보기', exact: true }).click();
  const transferredAnnotations = page.locator('.annotation-transferred');
  await expect(transferredAnnotations).toHaveCount(2);
  await expect(transferredAnnotations.filter({ hasText: 'shared bowing' })).toHaveCount(1);
  await expect(transferredAnnotations.filter({ hasText: 'second phrase' })).toHaveCount(1);
  const celloTab = page.getByRole('tab', { name: 'Cello' });
  const violinTab = page.getByRole('tab', { name: 'Violin 1' });
  const partTabs = page.getByRole('tab');
  const firstPartTab = partTabs.first();
  const lastPartTab = partTabs.last();
  await expect(celloTab).toHaveAttribute('tabindex', '0');
  await expect(violinTab).toHaveAttribute('tabindex', '-1');
  await expect(celloTab).toHaveAttribute('aria-controls', 'score-part-panel');
  await celloTab.focus();
  await page.keyboard.press('Home');
  await expect(firstPartTab).toHaveAttribute('aria-selected', 'true');
  await expect(firstPartTab).toBeFocused();
  await expect(page.getByLabel('현재 마디')).toHaveValue('11');
  await page.keyboard.press('End');
  await expect(lastPartTab).toHaveAttribute('aria-selected', 'true');
  await expect(lastPartTab).toBeFocused();
  await expect(page.getByLabel('현재 마디')).toHaveValue('11');
  const lastPartTabId = await lastPartTab.getAttribute('id');
  expect(lastPartTabId).toBeTruthy();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', lastPartTabId!);

  await page.evaluate(() => {
    localStorage.setItem(
      'fmr.practice.local',
      JSON.stringify([
        {
          id: 'practice-1',
          bodyMarkdown: '**crescendo**를 더 분명하게',
          measureNumber: 11,
          createdAt: new Date().toISOString(),
          authorDisplayName: '나',
          todos: [],
        },
      ]),
    );
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('feelmyrythm');
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('tempoMaps', 'readwrite');
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB write failed'));
        transaction.oncomplete = () => resolve();
        transaction.objectStore('tempoMaps').put({
          id: 'map-score-test',
          repertoireItemId: 'local',
          revision: 1,
          totalMeasures: 16,
          sections: [
            {
              id: 'section-score-test',
              label: 'A',
              startMeasure: 1,
              endMeasure: 16,
              timeSignature: { num: 4, denom: 4 },
              bpm: 100,
              beatUnit: 'quarter',
              accentPattern: [2, 1, 1, 1],
              subdivision: 1,
            },
          ],
          jumps: [],
          countIn: { measures: 1, useSectionMeter: true },
        });
      };
    });
  });

  await page.goto(`${scoreUrl}?measure=11`);
  await expect(page.getByText('11마디 연습 메모')).toBeVisible();
  await expect(page.getByText('crescendo', { exact: true })).toBeVisible();
  await expect(page.locator('.annotation-pen--project')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '이 마디부터 재생' })).toBeEnabled();

  for (const viewport of [
    { width: 256, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 839) {
      const toolbarToggle = page.getByRole('button', { name: '악보 도구' });
      await expect(toolbarToggle).toBeVisible();
      await toolbarToggle.click();
      await expect(page.getByRole('button', { name: '펜', exact: true })).toBeVisible();
      await toolbarToggle.click();
      await expect(page.locator('.score-stage')).toBeVisible();
    }
    const audit = await page.evaluate(() => {
      const visible = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const undersized = [
        ...document.querySelectorAll<HTMLElement>(
          'button, a[href], input:not([type="hidden"]), select, summary',
        ),
      ]
        .filter(visible)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          if (element instanceof HTMLInputElement && element.type === 'radio') {
            const label = element.closest('label')?.getBoundingClientRect();
            return !label || label.width < 44 || label.height < 44;
          }
          return box.width < 44 || box.height < 44;
        })
        .map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
      return {
        overflow: Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.documentElement.clientWidth,
        ),
        undersized,
      };
    });
    expect(audit.overflow, `${viewport.width}px populated score overflow`).toBeLessThanOrEqual(1);
    expect(audit.undersized, `${viewport.width}px populated score targets`).toEqual([]);
  }
});
