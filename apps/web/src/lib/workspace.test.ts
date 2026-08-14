import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api';
import { loadWorkspace, repertoireOptions, WORKSPACE_REQUEST_CONCURRENCY } from './workspace';

const timestamp = '2026-08-14T00:00:00Z';

function group(id: string, name = id) {
  return {
    id,
    name,
    description: '',
    myRole: 'owner',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function project(id: string, groupId: string) {
  return {
    id,
    groupId,
    name: id,
    description: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function repertoire(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: id,
    composer: '',
    notes: '',
    currentTempoMapRevision: 1,
    scoreCount: 0,
    openTodoCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const members = [
  {
    userId: 'user-1',
    displayName: 'Conductor',
    email: 'conductor@example.com',
    role: 'owner',
    joinedAt: timestamp,
  },
] as const;

describe('loadWorkspace', () => {
  it('hydrates successful groups, members, projects, and repertoire in source order', async () => {
    const groups = [group('group-1', 'Quartet'), group('group-2', 'Orchestra')];
    const projects = [project('project-1', 'group-1'), project('project-2', 'group-1')];
    const get = vi.fn((path: string): Promise<unknown> => {
      if (path === '/groups') return Promise.resolve(groups);
      if (path === '/groups/group-1/members') return Promise.resolve(members);
      if (path === '/groups/group-2/members') return Promise.resolve([]);
      if (path === '/groups/group-1/projects') return Promise.resolve(projects);
      if (path === '/groups/group-2/projects') return Promise.resolve([]);
      if (path === '/projects/project-1/repertoire') {
        return Promise.resolve([repertoire('repertoire-1', 'project-1')]);
      }
      if (path === '/projects/project-2/repertoire') {
        return Promise.resolve([repertoire('repertoire-2', 'project-2')]);
      }
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const workspace = await loadWorkspace({ get } as unknown as ApiClient);

    expect(workspace.failures).toEqual([]);
    expect(workspace.groups).toEqual([
      {
        ...groups[0],
        memberCount: 1,
        members,
        projects: [
          { ...projects[0], repertoire: [repertoire('repertoire-1', 'project-1')] },
          { ...projects[1], repertoire: [repertoire('repertoire-2', 'project-2')] },
        ],
      },
      {
        ...groups[1],
        memberCount: 0,
        members: [],
        projects: [],
      },
    ]);
    expect(repertoireOptions(workspace).map((item) => item.id)).toEqual([
      'repertoire-1',
      'repertoire-2',
    ]);
    expect(get).toHaveBeenCalledTimes(7);
  });

  it('bounds leaf traffic for a 50 group by 20 project workspace', async () => {
    const groups = Array.from({ length: 50 }, (_, groupIndex) => group(`group-${groupIndex}`));
    const projectsByGroup = new Map(
      groups.map((item, groupIndex) => [
        item.id,
        Array.from({ length: 20 }, (_, projectIndex) =>
          project(`project-${groupIndex}-${projectIndex}`, item.id),
        ),
      ]),
    );
    let activeLeafRequests = 0;
    let maximumLeafRequests = 0;
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path === '/groups') return groups;

      activeLeafRequests += 1;
      maximumLeafRequests = Math.max(maximumLeafRequests, activeLeafRequests);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      activeLeafRequests -= 1;

      const groupMatch = /^\/groups\/(group-\d+)\/(members|projects)$/.exec(path);
      if (groupMatch?.[2] === 'members') return [];
      if (groupMatch?.[2] === 'projects') return projectsByGroup.get(groupMatch[1] ?? '') ?? [];
      const projectMatch = /^\/projects\/(project-\d+-\d+)\/repertoire$/.exec(path);
      if (projectMatch) return [repertoire(`repertoire-${projectMatch[1]}`, projectMatch[1]!)];
      throw new Error(`Unexpected API path: ${path}`);
    });

    const workspace = await loadWorkspace({ get } as unknown as ApiClient);

    expect(maximumLeafRequests).toBe(WORKSPACE_REQUEST_CONCURRENCY);
    expect(workspace.failures).toEqual([]);
    expect(workspace.groups).toHaveLength(50);
    expect(repertoireOptions(workspace)).toHaveLength(1_000);
    expect(get).toHaveBeenCalledTimes(1 + 2 * 50 + 50 * 20);
  }, 10_000);

  it('keeps healthy projects when one repertoire leaf returns 503', async () => {
    const groups = [group('group-1', 'Quartet')];
    const projects = [project('project-good', 'group-1'), project('project-down', 'group-1')];
    const get = vi.fn((path: string): Promise<unknown> => {
      if (path === '/groups') return Promise.resolve(groups);
      if (path === '/groups/group-1/members') return Promise.resolve(members);
      if (path === '/groups/group-1/projects') return Promise.resolve(projects);
      if (path === '/projects/project-good/repertoire') {
        return Promise.resolve([repertoire('repertoire-good', 'project-good')]);
      }
      if (path === '/projects/project-down/repertoire') {
        return Promise.reject(new Error('503 Service Unavailable'));
      }
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const workspace = await loadWorkspace({ get } as unknown as ApiClient);

    expect(workspace.groups[0]?.projects).toEqual([
      { ...projects[0], repertoire: [repertoire('repertoire-good', 'project-good')] },
      {
        ...projects[1],
        repertoire: [],
        repertoireLoadError: '503 Service Unavailable',
      },
    ]);
    expect(workspace.failures).toEqual([
      {
        section: 'repertoire',
        groupId: 'group-1',
        groupName: 'Quartet',
        projectId: 'project-down',
        projectName: 'project-down',
        message: '503 Service Unavailable',
      },
    ]);
    expect(repertoireOptions(workspace).map((item) => item.id)).toEqual(['repertoire-good']);
  });

  it('rejects the whole load when the authoritative group root fails', async () => {
    const get = vi.fn(() => Promise.reject(new Error('503 groups unavailable')));

    await expect(loadWorkspace({ get } as unknown as ApiClient)).rejects.toThrow(
      '503 groups unavailable',
    );
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('/groups');
  });
});
