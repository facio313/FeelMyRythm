import type { components } from '@feelmyrythm/protocol';
import type { ApiClient } from './api';

type GroupResponse = components['schemas']['GroupOut'];
export type GroupMemberSummary = components['schemas']['GroupMemberOut'];
type ProjectResponse = components['schemas']['ProjectOut'];
export type RepertoireSummary = components['schemas']['RepertoireOut'];

export const WORKSPACE_REQUEST_CONCURRENCY = 6;

export type WorkspaceFailureSection = 'members' | 'projects' | 'repertoire';

export interface WorkspaceLoadFailure {
  section: WorkspaceFailureSection;
  groupId: string;
  groupName: string;
  projectId?: string;
  projectName?: string;
  message: string;
}

export type ProjectSummary = ProjectResponse & {
  repertoire: RepertoireSummary[];
  repertoireLoadError?: string;
};

export type GroupSummary = GroupResponse & {
  memberCount: number;
  members: GroupMemberSummary[];
  membersLoadError?: string;
  projects: ProjectSummary[];
  projectsLoadError?: string;
};

export interface WorkspaceLoadResult {
  groups: GroupSummary[];
  failures: WorkspaceLoadFailure[];
}

interface LimitedRequest {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function createRequestLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: LimitedRequest[] = [];

  function startNext() {
    while (active < maxConcurrent) {
      const request = queue.shift();
      if (!request) return;
      active += 1;
      void Promise.resolve()
        .then(request.run)
        .then(request.resolve, request.reject)
        .finally(() => {
          active -= 1;
          startNext();
        });
    }
  }

  return function limit<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      startNext();
    });
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function loadWorkspace(client: ApiClient): Promise<WorkspaceLoadResult> {
  // The root request remains authoritative: without it there is no safe workspace shape to show.
  const groups = await client.get<GroupResponse[]>('/groups');
  const limit = createRequestLimiter(WORKSPACE_REQUEST_CONCURRENCY);

  const groupLeafResults = await Promise.allSettled(
    groups.flatMap((group) => [
      limit(() => client.get<GroupMemberSummary[]>(`/groups/${group.id}/members`)),
      limit(() => client.get<ProjectResponse[]>(`/groups/${group.id}/projects`)),
    ]),
  );

  const projectsByGroup = new Map<string, ProjectResponse[]>();
  const membersByGroup = new Map<string, GroupMemberSummary[]>();
  const failures: WorkspaceLoadFailure[] = [];

  groups.forEach((group, index) => {
    const membersResult = groupLeafResults[index * 2];
    const projectsResult = groupLeafResults[index * 2 + 1];

    if (membersResult?.status === 'fulfilled') {
      membersByGroup.set(group.id, membersResult.value as GroupMemberSummary[]);
    } else {
      membersByGroup.set(group.id, []);
      failures.push({
        section: 'members',
        groupId: group.id,
        groupName: group.name,
        message: errorMessage(membersResult?.reason),
      });
    }

    if (projectsResult?.status === 'fulfilled') {
      projectsByGroup.set(group.id, projectsResult.value as ProjectResponse[]);
    } else {
      projectsByGroup.set(group.id, []);
      failures.push({
        section: 'projects',
        groupId: group.id,
        groupName: group.name,
        message: errorMessage(projectsResult?.reason),
      });
    }
  });

  const projectEntries = groups.flatMap((group) =>
    (projectsByGroup.get(group.id) ?? []).map((project) => ({ group, project })),
  );
  const repertoireResults = await Promise.allSettled(
    projectEntries.map(({ project }) =>
      limit(() => client.get<RepertoireSummary[]>(`/projects/${project.id}/repertoire`)),
    ),
  );
  const hydratedProjectsByGroup = new Map<string, ProjectSummary[]>();

  projectEntries.forEach(({ group, project }, index) => {
    const result = repertoireResults[index];
    const projects = hydratedProjectsByGroup.get(group.id) ?? [];
    if (result?.status === 'fulfilled') {
      projects.push({ ...project, repertoire: result.value });
    } else {
      const message = errorMessage(result?.reason);
      projects.push({ ...project, repertoire: [], repertoireLoadError: message });
      failures.push({
        section: 'repertoire',
        groupId: group.id,
        groupName: group.name,
        projectId: project.id,
        projectName: project.name,
        message,
      });
    }
    hydratedProjectsByGroup.set(group.id, projects);
  });

  return {
    groups: groups.map((group) => {
      const members = membersByGroup.get(group.id) ?? [];
      const membersFailure = failures.find(
        (failure) => failure.section === 'members' && failure.groupId === group.id,
      );
      const projectsFailure = failures.find(
        (failure) => failure.section === 'projects' && failure.groupId === group.id,
      );
      return {
        ...group,
        memberCount: members.length,
        members,
        ...(membersFailure ? { membersLoadError: membersFailure.message } : {}),
        projects: hydratedProjectsByGroup.get(group.id) ?? [],
        ...(projectsFailure ? { projectsLoadError: projectsFailure.message } : {}),
      };
    }),
    failures,
  };
}

export function repertoireOptions(
  workspace: WorkspaceLoadResult | GroupSummary[],
): RepertoireSummary[] {
  const groups = Array.isArray(workspace) ? workspace : workspace.groups;
  return groups.flatMap((group) => group.projects.flatMap((project) => project.repertoire));
}
