import { expect, test, type WebSocketRoute } from '@playwright/test';

interface ClientEnvelope {
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

interface ApiRequestRecord {
  method: string;
  path: string;
  authorization: string | undefined;
}

const roomId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const repertoireId = '44444444-4444-4444-8444-444444444444';
const tempoMapRevision = 7;
const timestamp = '2026-08-14T12:00:00Z';

const authState = {
  tokens: {
    accessToken: 'e2e-access',
    refreshToken: 'e2e-refresh',
    tokenType: 'bearer',
  },
  user: {
    id: 'leader-1',
    email: 'leader@example.test',
    displayName: 'E2E Leader',
    emailVerifiedAt: timestamp,
    hasPassword: true,
  },
};

const room = {
  roomId,
  repertoireId,
  leaderId: authState.user.id,
  tempoMapRevision,
  expiresAt: '2026-08-14T14:00:00Z',
};

const tempoMap = {
  id: '55555555-5555-4555-8555-555555555555',
  repertoireItemId: repertoireId,
  revision: tempoMapRevision,
  totalMeasures: 64,
  sections: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      label: 'Ensemble',
      startMeasure: 1,
      endMeasure: 64,
      timeSignature: { num: 4, denom: 4 },
      bpm: 100,
      beatUnit: 'quarter',
      accentPattern: [2, 1, 1, 1],
      subdivision: 1,
    },
  ],
  jumps: [],
  countIn: { measures: 1, useSectionMeter: true },
};

function sendServerEnvelope(
  socket: WebSocketRoute,
  type: string,
  payload: Record<string, unknown>,
): void {
  socket.send(JSON.stringify({ type, payload }));
}

test('creates a repertoire room and sends CMD_START through the mocked WebSocket', async ({
  page,
}) => {
  const clientMessages: ClientEnvelope[] = [];
  const apiRequests: ApiRequestRecord[] = [];
  const unexpectedApiRequests: string[] = [];
  let createBody: unknown;
  let roomReadAttempts = 0;
  let roomSocket: WebSocketRoute | undefined;
  let acceptRoomJoin = true;

  await page.addInitScript((state) => {
    localStorage.setItem('fmr.auth.session.v1', JSON.stringify(state));
  }, authState);

  await page.route('**/feelmyrythm/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/feelmyrythm/api', '');
    apiRequests.push({
      method: request.method(),
      path,
      authorization: request.headers().authorization,
    });

    if (request.method() === 'GET' && path === '/groups') {
      await route.fulfill({
        json: [
          {
            id: groupId,
            name: 'E2E Ensemble',
            description: 'Playwright fixture',
            myRole: 'leader',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
      return;
    }

    if (request.method() === 'GET' && path === `/groups/${groupId}/members`) {
      await route.fulfill({
        json: [
          {
            userId: authState.user.id,
            email: authState.user.email,
            displayName: authState.user.displayName,
            role: 'leader',
            joinedAt: timestamp,
          },
        ],
      });
      return;
    }

    if (request.method() === 'GET' && path === `/groups/${groupId}/projects`) {
      await route.fulfill({
        json: [
          {
            id: projectId,
            groupId,
            name: 'Orchestra Project',
            description: 'E2E project',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
      return;
    }

    if (request.method() === 'GET' && path === `/projects/${projectId}/repertoire`) {
      await route.fulfill({
        json: [
          {
            id: repertoireId,
            projectId,
            title: 'Symphony No. 5',
            composer: 'L. van Beethoven',
            notes: '',
            currentTempoMapRevision: tempoMapRevision,
            scoreCount: 1,
            openTodoCount: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
      return;
    }

    if (request.method() === 'POST' && path === '/rooms') {
      createBody = request.postDataJSON();
      await route.fulfill({ status: 201, json: room });
      return;
    }

    if (request.method() === 'GET' && path === `/rooms/${roomId}`) {
      roomReadAttempts += 1;
      if (roomReadAttempts === 1) {
        await route.fulfill({ status: 503, json: { detail: 'temporary room read failure' } });
        return;
      }
      await route.fulfill({ json: room });
      return;
    }

    if (
      request.method() === 'GET' &&
      path === `/repertoire/${repertoireId}/tempomap/revisions/${tempoMapRevision}`
    ) {
      await route.fulfill({
        json: {
          id: tempoMap.id,
          repertoireId,
          revision: tempoMapRevision,
          data: tempoMap,
          createdById: authState.user.id,
          createdAt: timestamp,
        },
      });
      return;
    }

    unexpectedApiRequests.push(`${request.method()} ${path}`);
    await route.fulfill({ status: 404, json: { detail: 'unexpected E2E request' } });
  });

  await page.routeWebSocket(
    (url) => url.pathname === `/feelmyrythm/ws/rooms/${roomId}`,
    (socket) => {
      roomSocket = socket;
      socket.onMessage((rawMessage) => {
        const message = JSON.parse(String(rawMessage)) as ClientEnvelope;
        clientMessages.push(message);

        if (message.type === 'JOIN_ROOM') {
          if (!acceptRoomJoin) return;
          sendServerEnvelope(socket, 'JOINED', {
            userId: authState.user.id,
            role: 'leader',
          });
          sendServerEnvelope(socket, 'ROOM_ROSTER', {
            members: [
              {
                userId: authState.user.id,
                displayName: authState.user.displayName,
                role: 'leader',
                ready: true,
                rttMs: 4.2,
                calibrated: true,
                bluetooth: false,
              },
            ],
          });
          sendServerEnvelope(socket, 'TRANSPORT', {
            roomId,
            repertoireId,
            tempoMapRevision,
            status: 'idle',
            anchor: { measure: 1, pass: 1 },
            countIn: true,
          });
        }

        if (message.type === 'CMD_START') {
          sendServerEnvelope(socket, 'TRANSPORT', {
            roomId,
            repertoireId,
            tempoMapRevision,
            status: 'playing',
            anchor: {
              measure: Number(message.payload?.measure ?? 1),
              pass: Number(message.payload?.pass ?? 1),
            },
            countIn: message.payload?.countIn !== false,
            serverStartTimeNs: (Date.now() + 3_000) * 1_000_000,
          });
        }
      });
    },
  );

  await page.goto('/feelmyrythm/session');
  const repertoireSelect = page.getByLabel('레퍼토리');
  await expect(repertoireSelect).toHaveValue(repertoireId);
  await expect(repertoireSelect).toContainText('Symphony No. 5 · rev.7');
  await page.getByRole('button', { name: '세션 열기' }).click();

  await expect(page).toHaveURL(new RegExp(`/feelmyrythm/session/${roomId}$`));
  expect(createBody).toEqual({ repertoireId });
  await expect(page.getByText(/세션의 템포맵을 불러오지 못했습니다/)).toBeVisible();
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect
    .poll(() =>
      apiRequests.some(
        (request) =>
          request.method === 'GET' &&
          request.path === `/repertoire/${repertoireId}/tempomap/revisions/${tempoMapRevision}`,
      ),
    )
    .toBe(true);
  expect(roomReadAttempts).toBe(2);
  expect(apiRequests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/groups' }),
      expect.objectContaining({ method: 'GET', path: `/groups/${groupId}/members` }),
      expect.objectContaining({ method: 'GET', path: `/groups/${groupId}/projects` }),
      expect.objectContaining({ method: 'GET', path: `/projects/${projectId}/repertoire` }),
      expect.objectContaining({ method: 'POST', path: '/rooms' }),
      expect.objectContaining({ method: 'GET', path: `/rooms/${roomId}` }),
      expect.objectContaining({
        method: 'GET',
        path: `/repertoire/${repertoireId}/tempomap/revisions/${tempoMapRevision}`,
      }),
    ]),
  );
  expect(apiRequests.every((request) => request.authorization === 'Bearer e2e-access')).toBe(true);
  expect(unexpectedApiRequests).toEqual([]);

  await expect
    .poll(() => clientMessages.some((message) => message.type === 'JOIN_ROOM'))
    .toBe(true);
  expect(clientMessages.findLast((message) => message.type === 'JOIN_ROOM')).toMatchObject({
    type: 'JOIN_ROOM',
    payload: { roomId, accessToken: 'e2e-access' },
  });

  await expect(page.getByText('동기화됨', { exact: true })).toBeVisible();
  await expect(page.getByText(authState.user.displayName, { exact: true }).last()).toBeVisible();
  await expect(page.getByText('1명', { exact: true })).toBeVisible();

  for (const viewport of [
    { width: 256, height: 568 },
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 667, height: 375 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const compact = viewport.width < 840;
    const mobileBar = page.locator('.session-mobile-bar');
    const desktopRoster = page.locator('.roster-panel--desktop');

    if (compact) {
      await expect(mobileBar).toBeVisible();
      await expect(desktopRoster).toBeHidden();
      await expect(mobileBar.getByRole('button', { name: /참가자/ })).toBeVisible();
      await expect(mobileBar.getByRole('button', { name: '준비 취소' })).toBeEnabled();
      await expect(mobileBar.getByRole('button', { name: '시작' })).toBeEnabled();

      const geometry = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.session-mobile-bar');
        const navigation = document.querySelector<HTMLElement>('.bottom-nav');
        if (!bar || !navigation) throw new Error('Compact session controls are missing');
        const barRect = bar.getBoundingClientRect();
        const navRect = navigation.getBoundingClientRect();
        const overlaps =
          barRect.left < navRect.right &&
          barRect.right > navRect.left &&
          barRect.top < navRect.bottom &&
          barRect.bottom > navRect.top;
        const targetHeights = [...bar.querySelectorAll<HTMLElement>('button')].map(
          (button) => button.getBoundingClientRect().height,
        );
        return {
          bar: {
            left: barRect.left,
            right: barRect.right,
            top: barRect.top,
            bottom: barRect.bottom,
          },
          overlaps,
          targetHeights,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(geometry.bar.left).toBeGreaterThanOrEqual(0);
      expect(geometry.bar.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.bar.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bar.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(geometry.overlaps).toBe(false);
      expect(geometry.targetHeights.every((height) => height >= 44)).toBe(true);
      expect(geometry.overflow).toBeLessThanOrEqual(1);

      if (viewport.width === 390) {
        await mobileBar.getByRole('button', { name: /참가자/ }).click();
        const rosterDialog = page.getByRole('dialog', { name: '참가자와 준비 상태' });
        await expect(rosterDialog).toBeVisible();
        await expect(
          rosterDialog.getByText(authState.user.displayName, { exact: true }),
        ).toBeVisible();
        await expect(rosterDialog.getByRole('button', { name: '준비 취소' })).toBeEnabled();
        await rosterDialog.getByRole('button', { name: '닫기' }).click();
      }
    } else {
      await expect(mobileBar).toBeHidden();
      await expect(desktopRoster).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByLabel('시작 마디').fill('26');
  await page.getByLabel('Pass').fill('2');
  await page.getByRole('button', { name: '3초 뒤 시작' }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error('Start control is not a button');
    button.click();
    button.click();
  });

  await expect
    .poll(() => clientMessages.filter((message) => message.type === 'CMD_START').length)
    .toBe(1);
  const startMessage = clientMessages.findLast((message) => message.type === 'CMD_START');
  expect(startMessage).toMatchObject({
    type: 'CMD_START',
    payload: { measure: 26, pass: 2, countIn: true },
  });
  expect(startMessage?.requestId).toEqual(expect.any(String));

  await expect(page.getByText('연주 중', { exact: true })).toBeVisible();
  await expect(
    page.getByText(`26마디 · pass 2 · revision ${tempoMapRevision}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '정지' })).toBeVisible();

  acceptRoomJoin = false;
  const connectedSocket = roomSocket;
  if (!connectedSocket) throw new Error('Mock room WebSocket was not opened');
  await connectedSocket.close({ code: 1012, reason: 'E2E reconnect audit' });
  await expect(page.getByText('재연결 중', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '정지' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '준비 취소' })).toBeDisabled();
});
