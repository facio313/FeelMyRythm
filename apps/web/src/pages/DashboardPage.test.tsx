import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as UiPackage from '@feelmyrythm/ui';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';

const database = vi.hoisted(() => ({
  listTempoMaps: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  client: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  user: null as { id: string; email: string; displayName: string } | null,
}));

vi.mock('../lib/localDb', () => ({
  localDb: database,
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => auth,
}));

vi.mock('@feelmyrythm/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiPackage>();
  return {
    ...actual,
    useToast: () => ({ notify: vi.fn() }),
  };
});

import { DashboardPage } from './DashboardPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface MemberFixture {
  userId: string;
  displayName: string;
  email: string;
  role: 'owner' | 'leader' | 'member';
  joinedAt: string;
}

function installMemberWorkspace(initialMembers: MemberFixture[]) {
  auth.user = {
    id: 'owner-1',
    email: 'owner@example.test',
    displayName: 'Owner',
  };
  let myRole: 'owner' | 'leader' | 'member' = 'owner';
  let members = initialMembers;
  auth.client.get.mockImplementation((path: string) => {
    if (path === '/groups') {
      return Promise.resolve([
        {
          id: 'group-1',
          name: 'Quartet',
          description: '',
          myRole,
          createdAt: '2026-08-14T00:00:00Z',
          updatedAt: '2026-08-14T00:00:00Z',
        },
      ]);
    }
    if (path === '/groups/group-1/members') {
      return Promise.resolve(members.map((member) => ({ ...member })));
    }
    if (path === '/groups/group-1/projects') return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
  return {
    setMemberRole(userId: string, role: 'leader' | 'member') {
      members = members.map((member) => (member.userId === userId ? { ...member, role } : member));
    },
    setMyRole(role: 'owner' | 'leader' | 'member') {
      myRole = role;
    },
  };
}

async function openMemberManager() {
  fireEvent.click(await screen.findByRole('button', { name: '멤버 관리' }));
  return screen.findByRole('dialog', { name: '멤버 관리' });
}

describe('DashboardPage local data states', () => {
  beforeEach(() => {
    database.listTempoMaps.mockReset();
    database.listTempoMaps.mockResolvedValue([]);
    auth.user = null;
    auth.client.get.mockReset();
    auth.client.post.mockReset();
    auth.client.patch.mockReset();
    auth.client.delete.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a labelled loading state instead of a false zero before IndexedDB resolves', async () => {
    let resolveMaps: (maps: unknown[]) => void = () => undefined;
    database.listTempoMaps.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMaps = resolve;
        }),
    );

    renderPage();
    expect(screen.getByText('이 기기의 연습 데이터를 확인하고 있습니다.')).toBeInTheDocument();
    expect(screen.getByText('저장된 템포맵 확인 중…').closest('[role="status"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    await act(async () => resolveMaps([{}, {}]));
    expect(
      await screen.findByText('혼자 연습한 내용은 안전하게 이 기기에 있습니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the IndexedDB error inline and retries without requiring login', async () => {
    database.listTempoMaps
      .mockRejectedValueOnce(new Error('IndexedDB blocked'))
      .mockResolvedValueOnce([]);

    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('IndexedDB blocked');
    expect(screen.getByText('이 기기의 연습 데이터를 불러오지 못했습니다.')).toBeInTheDocument();
    expect(screen.getByText('개수를 확인할 수 없음')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(database.listTempoMaps).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('혼자 연습한 내용은 안전하게 이 기기에 있습니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('keeps healthy repertoire visible and retries only after reporting partial workspace data', async () => {
    auth.user = {
      id: 'user-1',
      email: 'player@example.test',
      displayName: 'Player',
    };
    let rootAttempts = 0;
    auth.client.get.mockImplementation((path: string) => {
      if (path === '/groups') {
        rootAttempts += 1;
        return Promise.resolve([
          {
            id: 'group-1',
            name: 'Quartet',
            description: '',
            myRole: 'owner',
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ]);
      }
      if (path === '/groups/group-1/members') return Promise.resolve([]);
      if (path === '/groups/group-1/projects') {
        return Promise.resolve([
          {
            id: 'project-good',
            groupId: 'group-1',
            name: 'Concert',
            description: '',
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
          {
            id: 'project-retry',
            groupId: 'group-1',
            name: 'Chamber',
            description: '',
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ]);
      }
      if (path === '/projects/project-good/repertoire') {
        return Promise.resolve([
          {
            id: 'repertoire-good',
            projectId: 'project-good',
            title: 'Healthy suite',
            composer: 'Composer',
            notes: '',
            currentTempoMapRevision: 1,
            scoreCount: 0,
            openTodoCount: 0,
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ]);
      }
      if (path === '/projects/project-retry/repertoire') {
        if (rootAttempts === 1) return Promise.reject(new Error('503 Service Unavailable'));
        return Promise.resolve([
          {
            id: 'repertoire-recovered',
            projectId: 'project-retry',
            title: 'Recovered quartet',
            composer: 'Composer',
            notes: '',
            currentTempoMapRevision: 1,
            scoreCount: 0,
            openTodoCount: 0,
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    renderPage();

    expect(await screen.findByText('Healthy suite')).toBeInTheDocument();
    expect(screen.getByText('Chamber의 레퍼토리를 불러오지 못했습니다.')).toBeInTheDocument();
    const partialHeading = screen.getByRole('heading', {
      name: '일부 프로젝트 정보를 불러오지 못했습니다.',
    });
    const partialAlert = partialHeading.closest<HTMLElement>('[role="alert"]');
    expect(partialAlert).not.toBeNull();

    fireEvent.click(within(partialAlert!).getByRole('button', { name: '누락된 정보 다시 시도' }));

    expect(await screen.findByText('Recovered quartet')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: '일부 프로젝트 정보를 불러오지 못했습니다.' }),
      ).not.toBeInTheDocument(),
    );
    expect(auth.client.get.mock.calls.filter(([path]) => path === '/groups')).toHaveLength(2);
  });
});

describe('DashboardPage member mutation gate', () => {
  const alice: MemberFixture = {
    userId: 'member-alice',
    displayName: 'Alice',
    email: 'alice@example.test',
    role: 'member',
    joinedAt: '2026-08-14T00:00:00Z',
  };
  const bob: MemberFixture = {
    userId: 'member-bob',
    displayName: 'Bob',
    email: 'bob@example.test',
    role: 'leader',
    joinedAt: '2026-08-14T00:00:00Z',
  };

  beforeEach(() => {
    database.listTempoMaps.mockReset();
    database.listTempoMaps.mockResolvedValue([]);
    auth.client.get.mockReset();
    auth.client.post.mockReset();
    auth.client.patch.mockReset();
    auth.client.delete.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('runs only one slow mutation for the same member and marks the whole row busy', async () => {
    const workspace = installMemberWorkspace([alice]);
    const request = deferred<void>();
    auth.client.patch.mockReturnValue(request.promise);

    renderPage();
    const dialog = await openMemberManager();
    const roleSelect = within(dialog).getByRole('combobox', { name: 'Alice 역할' });

    fireEvent.change(roleSelect, { target: { value: 'leader' } });

    const row = within(dialog).getByRole('group', { name: 'Alice 멤버 관리' });
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(within(row).getByRole('status')).toHaveTextContent('업데이트 중…');
    expect(roleSelect).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Alice 멤버 정보 업데이트 중' })).toBeDisabled();

    fireEvent.change(roleSelect, { target: { value: 'member' } });
    expect(auth.client.patch).toHaveBeenCalledTimes(1);
    expect(auth.client.patch).toHaveBeenCalledWith('/groups/group-1/members/member-alice', {
      role: 'leader',
    });

    workspace.setMemberRole('member-alice', 'leader');
    await act(async () => request.resolve());

    const reloadedSelect = await screen.findByRole('combobox', { name: 'Alice 역할' });
    await waitFor(() => expect(reloadedSelect).toBeEnabled());
    expect(reloadedSelect).toHaveValue('leader');
  });

  it('allows mutations for different members to remain concurrent', async () => {
    const workspace = installMemberWorkspace([alice, bob]);
    const aliceRequest = deferred<void>();
    const bobRequest = deferred<void>();
    auth.client.patch.mockImplementation((path: string) =>
      path.endsWith('member-alice') ? aliceRequest.promise : bobRequest.promise,
    );

    renderPage();
    const dialog = await openMemberManager();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Alice 역할' }), {
      target: { value: 'leader' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Bob 역할' }), {
      target: { value: 'member' },
    });

    expect(auth.client.patch).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole('combobox', { name: 'Alice 역할' })).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'Bob 역할' })).toBeDisabled();

    workspace.setMemberRole('member-alice', 'leader');
    workspace.setMemberRole('member-bob', 'member');
    await act(async () => {
      aliceRequest.resolve();
      bobRequest.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Alice 역할' })).toBeEnabled();
      expect(screen.getByRole('combobox', { name: 'Bob 역할' })).toBeEnabled();
    });
  });

  it('releases a failed member gate so the same action can be retried', async () => {
    const workspace = installMemberWorkspace([alice]);
    const firstRequest = deferred<void>();
    const retryRequest = deferred<void>();
    auth.client.patch
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);

    renderPage();
    await openMemberManager();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 역할' }), {
      target: { value: 'leader' },
    });

    await act(async () => firstRequest.reject(new Error('network unavailable')));
    const retrySelect = await screen.findByRole('combobox', { name: 'Alice 역할' });
    await waitFor(() => expect(retrySelect).toBeEnabled());

    fireEvent.change(retrySelect, { target: { value: 'leader' } });
    expect(auth.client.patch).toHaveBeenCalledTimes(2);

    workspace.setMemberRole('member-alice', 'leader');
    await act(async () => retryRequest.resolve());
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Alice 역할' })).toHaveValue('leader'),
    );
  });

  it('closes member management and reloads authority after a permission failure', async () => {
    const workspace = installMemberWorkspace([alice]);
    auth.client.patch.mockImplementationOnce(() => {
      workspace.setMyRole('member');
      return Promise.reject(new ApiError(403, { detail: 'Permission changed' }));
    });

    renderPage();
    await openMemberManager();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 역할' }), {
      target: { value: 'leader' },
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '멤버 관리' })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(auth.client.get.mock.calls.filter(([path]) => path === '/groups')).toHaveLength(2),
    );
    expect(screen.queryByRole('button', { name: '멤버 관리' })).not.toBeInTheDocument();
  });
});
