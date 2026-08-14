import { assertValidTempoMap, type TempoMap } from '@feelmyrythm/core';

export interface TempoMapResolution {
  map: TempoMap;
  source: 'local' | 'server';
  /** Same revision but different musical contents requires an explicit user choice. */
  conflict: boolean;
}

function musicalSnapshot(map: TempoMap): string {
  return JSON.stringify({ ...map, revision: 0 });
}

/**
 * Resolve a cached and server TempoMap without silently discarding a newer edit.
 * A higher revision wins. Divergent contents at the same revision remain a
 * conflict and default to the server until the user explicitly chooses.
 */
export function resolveTempoMaps(
  local: TempoMap | undefined,
  server: TempoMap | undefined,
): TempoMapResolution {
  if (!local && !server) throw new Error('비교할 템포맵이 없습니다.');
  if (local) assertValidTempoMap(local);
  if (server) assertValidTempoMap(server);
  if (!server) return { map: local!, source: 'local', conflict: false };
  if (!local) return { map: server, source: 'server', conflict: false };

  if (local.repertoireItemId !== server.repertoireItemId) {
    throw new Error('서로 다른 레퍼토리의 템포맵은 병합할 수 없습니다.');
  }
  if (local.revision > server.revision) {
    return { map: local, source: 'local', conflict: false };
  }
  if (server.revision > local.revision) {
    return { map: server, source: 'server', conflict: false };
  }
  const conflict = musicalSnapshot(local) !== musicalSnapshot(server);
  return { map: server, source: 'server', conflict };
}

/** Preserve a user's musical draft while rebasing it onto the current server identity/revision. */
export function rebaseTempoMapDraft(draft: TempoMap, latestServer: TempoMap): TempoMap {
  assertValidTempoMap(draft);
  assertValidTempoMap(latestServer);
  if (draft.repertoireItemId !== latestServer.repertoireItemId) {
    throw new Error('서로 다른 레퍼토리의 템포맵은 덮어쓸 수 없습니다.');
  }
  return {
    ...draft,
    id: latestServer.id,
    repertoireItemId: latestServer.repertoireItemId,
    revision: latestServer.revision,
  };
}
