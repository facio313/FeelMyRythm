import { expect, test, type Page } from '@playwright/test';

const repertoireId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-08-14T12:00:00Z';

const authState = {
  tokens: {
    accessToken: 'editor-e2e-access',
    refreshToken: 'editor-e2e-refresh',
    tokenType: 'bearer',
  },
  user: {
    id: 'leader-1',
    email: 'leader@example.test',
    displayName: 'Editor Leader',
    emailVerifiedAt: timestamp,
    hasPassword: true,
  },
};

async function installAuthSession(page: Page) {
  await page.addInitScript((session) => {
    localStorage.setItem('fmr.auth.session.v1', JSON.stringify(session));
  }, authState);
}

function tempoMap(revision: number, bpm: number, id = 'server-map') {
  return {
    id,
    repertoireItemId: repertoireId,
    revision,
    totalMeasures: 100,
    sections: [
      {
        id: `${id}-section`,
        label: 'A',
        startMeasure: 1,
        endMeasure: 100,
        timeSignature: { num: 4, denom: 4 },
        bpm,
        beatUnit: 'quarter',
        accentPattern: [2, 1, 1, 1],
        subdivision: 1,
      },
    ],
    jumps: [],
    countIn: { measures: 1, useSectionMeter: true },
  };
}

function serverTempoMap(data: ReturnType<typeof tempoMap>) {
  return {
    id: data.id,
    repertoireId,
    revision: data.revision,
    data,
    createdById: authState.user.id,
    createdAt: timestamp,
  };
}

async function readCachedTempoMaps(page: Page, cacheOwnerId?: string) {
  return page.evaluate(
    ({ ownerId }) =>
      new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const openRequest = indexedDB.open('feelmyrythm');
        openRequest.onerror = () =>
          reject(openRequest.error ?? new Error('Failed to open the E2E IndexedDB database'));
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          try {
            const storeName = ownerId ? 'remoteTempoMaps' : 'tempoMaps';
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onerror = () =>
              reject(request.error ?? new Error('Failed to read the saved E2E tempo maps'));
            request.onsuccess = () => {
              const records = request.result as Array<Record<string, unknown>>;
              resolve(
                ownerId ? records.filter((record) => record.cacheOwnerId === ownerId) : records,
              );
            };
            transaction.oncomplete = () => database.close();
          } catch (error) {
            database.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
      }),
    { ownerId: cacheOwnerId },
  );
}

async function seedCachedTempoMap(
  page: Page,
  cached: ReturnType<typeof tempoMap> & { updatedAt?: string },
  cacheOwnerId?: string,
) {
  await page.evaluate(
    ({ ownerId, value }) =>
      new Promise<void>((resolve, reject) => {
        const openRequest = indexedDB.open('feelmyrythm');
        openRequest.onerror = () =>
          reject(openRequest.error ?? new Error('Failed to open the E2E IndexedDB database'));
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          try {
            const storeName = ownerId ? 'remoteTempoMaps' : 'tempoMaps';
            const transaction = database.transaction(storeName, 'readwrite');
            transaction.objectStore(storeName).put(
              ownerId
                ? {
                    ...value,
                    cacheOwnerId: ownerId,
                  }
                : value,
            );
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
            transaction.onerror = () =>
              reject(transaction.error ?? new Error('Failed to seed the E2E IndexedDB database'));
          } catch (error) {
            database.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
      }),
    { ownerId: cacheOwnerId, value: cached },
  );
}

test('builds and saves the 100 BPM → measure 26 at 130 BPM → 1st/2nd ending scenario', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/feelmyrythm/editor');
  await expect(page.getByRole('heading', { name: '템포맵 편집기' })).toBeVisible();
  await expect(page.getByText('유효함', { exact: true })).toBeVisible();

  await page.getByLabel('총 마디 수').fill('100');
  await page.getByLabel('예비박').selectOption('2');
  await page.getByLabel('못갖춘마디').selectOption('enabled');
  await page.getByLabel('못갖춘 박 수').fill('1');

  const sectionProperties = page.locator('.section-properties');
  await expect(sectionProperties.getByLabel('BPM')).toHaveValue('100');
  await page.getByRole('button', { name: '구간 나누기' }).click();
  const splitDialog = page.getByRole('dialog', { name: '구간 나누기' });
  await splitDialog.getByRole('spinbutton').fill('26');
  await splitDialog.getByRole('button', { name: '나누기' }).click();

  await expect(page.locator('.tempo-block')).toHaveCount(2);
  await expect(page.locator('.tempo-block').nth(0)).toContainText('1–25 · 100');
  await expect(page.locator('.tempo-block').nth(1)).toContainText('26–100 · 100');

  await page.getByRole('button', { name: '구간 위로 이동' }).click();
  await expect(page.locator('.tempo-block').nth(0)).toContainText('1–75 · 100');
  await page.getByRole('button', { name: '구간 아래로 이동' }).click();
  await expect(page.locator('.tempo-block').nth(1)).toContainText('26–100 · 100');

  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.tempo-block')).toHaveCount(1);
  await page.getByRole('button', { name: '삭제 취소' }).click();
  await expect(page.locator('.tempo-block')).toHaveCount(2);

  await page.getByRole('button', { name: '이전과 합치기' }).click();
  await expect(page.locator('.tempo-block')).toHaveCount(1);
  await expect(page.locator('.tempo-block').first()).toContainText('1–100 · 100');
  await page.getByRole('button', { name: '구간 나누기' }).click();
  await splitDialog.getByRole('spinbutton').fill('26');
  await splitDialog.getByRole('button', { name: '나누기' }).click();
  await expect(page.locator('.tempo-block')).toHaveCount(2);

  await sectionProperties.getByLabel('구간 이름').fill('Allegro');
  await sectionProperties.getByLabel('BPM').fill('130');
  await sectionProperties.getByLabel('템포 변화').selectOption('accel');
  const targetBpm = sectionProperties.getByLabel('도착 BPM');
  await targetBpm.fill('120');
  await expect(targetBpm).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.validation-summary')).toContainText('sections[1].tempoChange');
  await targetBpm.fill('140');
  await sectionProperties.getByLabel('3박').selectOption('0');

  await page.getByRole('button', { name: '도돌이·볼타 추가' }).click();
  await expect(page.getByLabel('26–100마디 2회 반복')).toBeVisible();
  await page.getByRole('button', { name: '볼타 엔딩 추가' }).click();
  await page.getByRole('button', { name: '볼타 엔딩 추가' }).click();

  const endings = page.locator('.volta-ending');
  await expect(endings).toHaveCount(2);
  await endings.nth(0).getByLabel('엔딩 시작 마디').fill('90');
  await endings.nth(0).getByLabel('엔딩 끝 마디').fill('95');
  await endings.nth(1).getByLabel('엔딩 시작 마디').fill('96');
  await endings.nth(1).getByLabel('엔딩 끝 마디').fill('100');
  await expect(endings.nth(0).getByLabel('1번째 패스')).toBeChecked();
  await expect(endings.nth(1).getByLabel('2번째 패스')).toBeChecked();
  await expect(page.getByText('유효함', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '표', exact: true }).click();
  const sectionTable = page.getByRole('table', { name: '템포 구간' });
  await expect(sectionTable).toContainText('1–25');
  await expect(sectionTable).toContainText('26–100');
  await expect(sectionTable).toContainText('100');
  await expect(sectionTable).toContainText('130');
  await expect(sectionTable.getByRole('columnheader')).toHaveCount(4);
  await expect(sectionTable.getByRole('columnheader', { name: '구간' })).toBeVisible();
  await expect(sectionTable.getByRole('columnheader', { name: '마디' })).toBeVisible();
  await expect(sectionTable.getByRole('columnheader', { name: '박자' })).toBeVisible();
  await expect(sectionTable.getByRole('columnheader', { name: 'BPM' })).toBeVisible();
  const allegroSelector = sectionTable.getByRole('button', { name: 'Allegro' });
  await expect(allegroSelector).toHaveAttribute('aria-pressed', 'true');
  const openingSelector = sectionTable.getByRole('button', { name: 'A', exact: true });
  await openingSelector.focus();
  await page.keyboard.press('Enter');
  await expect(openingSelector).toHaveAttribute('aria-pressed', 'true');
  await expect(allegroSelector).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('템포맵을 저장했습니다.', { exact: true })).toBeVisible();

  const savedMaps = await readCachedTempoMaps(page);
  expect(savedMaps).toEqual([
    expect.objectContaining({
      revision: 2,
      totalMeasures: 100,
      anacrusis: { beats: 1 },
      countIn: { measures: 2, useSectionMeter: true },
      sections: [
        expect.objectContaining({ startMeasure: 1, endMeasure: 25, bpm: 100 }),
        expect.objectContaining({
          label: 'Allegro',
          startMeasure: 26,
          endMeasure: 100,
          bpm: 130,
          accentPattern: [2, 1, 0, 1],
          tempoChange: { type: 'accel', targetBpm: 140 },
        }),
      ],
      jumps: [
        {
          type: 'repeat',
          startMeasure: 26,
          endMeasure: 100,
          times: 2,
          endings: [
            { measures: [90, 95], forPass: [1] },
            { measures: [96, 100], forPass: [2] },
          ],
        },
      ],
    }),
  ]);
  const savedId = savedMaps[0]?.id;
  expect(typeof savedId).toBe('string');
  await page.goto(`/feelmyrythm/editor/${String(savedId)}`);
  await expect(page.getByLabel('총 마디 수')).toHaveValue('100');
  await expect(page.locator('.tempo-block')).toHaveCount(2);
  expect(pageErrors).toEqual([]);
});

test('keeps the server authoritative online and requires an explicit save after a 409 rebase', async ({
  page,
}) => {
  const putBodies: Array<{ expectedRevision: number; data: ReturnType<typeof tempoMap> }> = [];
  let latestRevision = 5;

  await installAuthSession(page);

  await page.route('**/feelmyrythm/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/feelmyrythm/api', '');
    if (request.method() === 'GET' && path === `/repertoire/${repertoireId}/tempomap`) {
      const data =
        latestRevision === 5 ? tempoMap(5, 120) : tempoMap(latestRevision, 140, 'server-map');
      await route.fulfill({ json: serverTempoMap(data) });
      return;
    }
    if (request.method() === 'PUT' && path === `/repertoire/${repertoireId}/tempomap`) {
      const body = request.postDataJSON() as {
        expectedRevision: number;
        data: ReturnType<typeof tempoMap>;
      };
      putBodies.push(body);
      if (putBodies.length === 1) {
        latestRevision = 6;
        await route.fulfill({
          status: 409,
          json: {
            detail: {
              message: 'tempo map revision conflict',
              expectedRevision: 5,
              actualRevision: 6,
            },
          },
        });
        return;
      }
      latestRevision = 7;
      const saved = { ...body.data, id: 'server-map', revision: 7 };
      await route.fulfill({ json: serverTempoMap(saved) });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { detail: `Unexpected ${request.method()} ${path}` },
    });
  });

  await page.goto(`/feelmyrythm/editor/${repertoireId}`);
  await expect(page.locator('.section-properties').getByLabel('BPM')).toHaveValue('120');
  await expect
    .poll(async () => (await readCachedTempoMaps(page, authState.user.id)).length)
    .toBeGreaterThan(0);
  await seedCachedTempoMap(page, tempoMap(5, 90), authState.user.id);
  await page.reload();
  const bpm = page.locator('.section-properties').getByLabel('BPM');
  await expect(bpm).toHaveValue('120');
  await expect(page.getByRole('dialog', { name: '같은 revision의 내용이 다릅니다' })).toHaveCount(
    0,
  );
  await bpm.fill('95');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const saveConflict = page.getByRole('dialog', { name: '저장 충돌을 해결하세요' });
  await expect(saveConflict).toBeVisible();
  await expect(saveConflict).toContainText('서버 최신본 · revision 6');
  expect(putBodies[0]).toMatchObject({ expectedRevision: 5, data: { revision: 5 } });
  expect(putBodies[0]?.data.sections[0]?.bpm).toBe(95);

  await saveConflict.getByRole('button', { name: '내 초안을 최신 revision에 재기준' }).click();
  await expect(page.locator('.editor-rebase-notice')).toContainText(
    '서버 revision 6에 재기준했습니다',
  );
  await expect(page.getByText('템포맵을 저장했습니다.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '재기준 초안 저장', exact: true }).click();
  await expect(page.getByText('템포맵을 저장했습니다.', { exact: true })).toBeVisible();

  expect(putBodies).toHaveLength(2);
  expect(putBodies[1]).toMatchObject({ expectedRevision: 6, data: { revision: 6 } });
  expect(putBodies[1]?.data.sections[0]?.bpm).toBe(95);
  const cached = await readCachedTempoMaps(page, authState.user.id);
  expect(cached).toContainEqual(
    expect.objectContaining({ id: 'server-map', revision: 7, repertoireItemId: repertoireId }),
  );
});

test('ignores IndexedDB bookkeeping when equal revisions have identical contents', async ({
  page,
}) => {
  let online = true;
  await installAuthSession(page);
  const shared = tempoMap(5, 120);
  await page.route('**/feelmyrythm/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/feelmyrythm/api', '');
    if (request.method() === 'GET' && path === `/repertoire/${repertoireId}/tempomap`) {
      if (!online) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({ json: serverTempoMap(shared) });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: 'unexpected request' } });
  });

  await page.goto(`/feelmyrythm/editor/${repertoireId}`);
  await expect(page.locator('.section-properties').getByLabel('BPM')).toHaveValue('120');
  await expect
    .poll(async () => (await readCachedTempoMaps(page, authState.user.id)).length)
    .toBeGreaterThan(0);
  await seedCachedTempoMap(page, { ...shared, updatedAt: timestamp }, authState.user.id);
  online = false;
  await page.reload();
  await expect(page.locator('.section-properties').getByLabel('BPM')).toHaveValue('120');
  await expect(page.getByText('오프라인 읽기 전용으로 열었습니다.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '같은 revision의 내용이 다릅니다' })).toHaveCount(
    0,
  );
});

test('keeps the compact save action visible above navigation without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feelmyrythm/editor');

  const saveBar = page.locator('.editor-save-bar');
  await expect(saveBar).toBeVisible();
  const initialBox = await saveBar.boundingBox();
  expect(initialBox).not.toBeNull();
  expect(initialBox!.y + initialBox!.height).toBeLessThanOrEqual(844);
  expect(initialBox!.y).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => document.querySelector('#main-content')?.scrollTo(0, 10_000));
  const scrolledBox = await saveBar.boundingBox();
  expect(scrolledBox).not.toBeNull();
  expect(scrolledBox!.y + scrolledBox!.height).toBeLessThanOrEqual(844);
  const saveButton = saveBar.getByRole('button', { name: '저장', exact: true });
  const buttonBox = await saveButton.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('guards compact tab links and browser back until the user resolves unsaved changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feelmyrythm/');
  const mobileNavigation = page.getByRole('navigation', { name: '모바일 주요 메뉴' });
  await mobileNavigation.getByRole('button', { name: '더보기' }).click();
  await page.getByRole('dialog', { name: '더보기' }).getByRole('link', { name: '템포맵' }).click();
  await expect(page).toHaveURL(/\/feelmyrythm\/editor$/);
  await page.locator('.section-properties').getByLabel('BPM').fill('126');
  await expect(page.getByText('저장 안 됨', { exact: true })).toBeVisible();

  await page.evaluate(() => window.history.back());
  const backDialog = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
  await expect(backDialog).toBeVisible();
  await expect(page).toHaveURL(/\/feelmyrythm\/editor$/);
  await backDialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(backDialog).toBeHidden();

  await mobileNavigation.getByRole('link', { name: '앙상블' }).click();
  const tabDialog = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
  await expect(tabDialog).toBeVisible();
  await tabDialog.getByRole('button', { name: '저장 후 이동' }).click();

  await expect(page).toHaveURL(/\/feelmyrythm\/session$/);
  await expect(page.getByRole('heading', { name: '앙상블 세션' })).toBeVisible();
  const savedMaps = await readCachedTempoMaps(page);
  expect(savedMaps).toContainEqual(
    expect.objectContaining({ revision: 2, sections: [expect.objectContaining({ bpm: 126 })] }),
  );
});

test('keeps the pending route blocked when save-and-leave fails', async ({ page }) => {
  let putAttempts = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await installAuthSession(page);
  await page.route('**/feelmyrythm/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/feelmyrythm/api', '');
    if (request.method() === 'GET' && path === `/repertoire/${repertoireId}/tempomap`) {
      await route.fulfill({ json: serverTempoMap(tempoMap(5, 120)) });
      return;
    }
    if (request.method() === 'PUT' && path === `/repertoire/${repertoireId}/tempomap`) {
      putAttempts += 1;
      await route.fulfill({ status: 503, json: { detail: 'temporary save failure' } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: 'unexpected request' } });
  });

  await page.goto(`/feelmyrythm/editor/${repertoireId}`);
  await page.locator('.section-properties').getByLabel('BPM').fill('126');
  await page
    .getByRole('navigation', { name: '모바일 주요 메뉴' })
    .getByRole('link', { name: '앙상블' })
    .click();
  const dialog = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다' });
  await dialog.getByRole('button', { name: '저장 후 이동' }).click();

  await expect(page.getByText('저장하지 못했습니다.', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feelmyrythm/editor/${repertoireId}$`));
  expect(putAttempts).toBe(1);
});

test('adds, changes, and removes D.C., D.S., Fine, and Coda through named fields', async ({
  page,
}) => {
  await page.goto('/feelmyrythm/editor');
  const jumpPanel = page.locator('.jump-panel');
  const newType = jumpPanel.getByLabel('새 이동 지시 종류');

  await newType.selectOption('dc');
  await jumpPanel.getByRole('button', { name: 'D.C. 추가' }).click();
  const directive = jumpPanel.locator('.jump-editor').first();
  await expect(directive.getByLabel('D.C. 실행 마디')).toBeVisible();
  await directive.getByLabel('al Fine').check();
  await directive.getByRole('spinbutton', { name: 'Fine 마디', exact: true }).fill('32');

  await directive.getByLabel('지시 종류').selectOption('ds');
  await expect(directive.getByLabel('D.S. 실행 마디')).toBeVisible();
  await expect(directive.getByLabel('Segno 마디')).toBeVisible();
  await directive.getByRole('button', { name: 'D.S. 삭제' }).click();

  await newType.selectOption('coda');
  await jumpPanel.getByRole('button', { name: 'To Coda·Coda 추가' }).click();
  await expect(jumpPanel.getByLabel('To Coda 마디')).toBeVisible();
  await expect(jumpPanel.getByLabel('Coda 시작 마디')).toBeVisible();
  await jumpPanel.getByRole('button', { name: 'To Coda·Coda 삭제' }).click();
  await expect(jumpPanel.locator('code')).toHaveCount(0);

  const tap = page.getByRole('button', { name: '탭 템포', exact: true });
  await tap.click();
  await page.waitForTimeout(600);
  await tap.click();
  await expect(page.getByText(/탭 평균 \d+ BPM/)).toBeVisible();
});
