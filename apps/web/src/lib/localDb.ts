import type { TempoMap } from '@feelmyrythm/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface RemoteCacheScope {
  userId: string;
}

export interface LocalScore {
  id: string;
  repertoireItemId: string;
  name: string;
  kind: 'full' | 'part';
  instrument?: string;
  mimeType: string;
  blob: Blob;
  tempoMapId?: string;
  updatedAt: string;
}

export interface LocalMeasureMap {
  scoreId: string;
  measureNumberOffset: number;
  regions: Array<{
    id: string;
    page: number;
    measureNumber: number;
    rect: { x: number; y: number; w: number; h: number };
  }>;
  updatedAt: string;
}

export interface LocalAnnotation {
  id: string;
  scoreId: string;
  scope: 'private' | 'project';
  kind: 'pen' | 'text' | 'stamp';
  page: number;
  measureNumber?: number;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface DeviceCalibration {
  id: string;
  deviceFingerprint: string;
  outputLabel: string;
  offsetMs: number;
  samples: number[];
  updatedAt: string;
}

export interface CachedPracticeLog {
  id: string;
  repertoireId: string;
  authorId: string;
  authorName: string;
  content: string;
  anchors: Array<{
    measureNumber?: number;
    scoreId?: string;
    page?: number;
    x?: number;
    y?: number;
    note?: string;
  }>;
  todos?: Array<{
    id: string;
    content: string;
    createdById?: string;
    assigneeId?: string;
    dueDate?: string;
    completed: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

type RemoteTempoMap = TempoMap & { cacheOwnerId: string; updatedAt?: string };
type RemoteScore = LocalScore & { cacheOwnerId: string };
type RemoteMeasureMap = LocalMeasureMap & { cacheOwnerId: string };
type RemoteAnnotation = LocalAnnotation & { cacheOwnerId: string };
type RemoteCacheStoreName =
  | 'remoteTempoMaps'
  | 'remoteScores'
  | 'remoteMeasureMaps'
  | 'remoteAnnotations'
  | 'remotePracticeLogs';

const REMOTE_CACHE_STORES: readonly RemoteCacheStoreName[] = [
  'remoteTempoMaps',
  'remoteScores',
  'remoteMeasureMaps',
  'remoteAnnotations',
  'remotePracticeLogs',
];

interface FmrDb extends DBSchema {
  tempoMaps: {
    key: string;
    value: TempoMap & { updatedAt?: string };
    indexes: { repertoireItemId: string };
  };
  scores: {
    key: string;
    value: LocalScore;
    indexes: { repertoireItemId: string };
  };
  measureMaps: {
    key: string;
    value: LocalMeasureMap;
  };
  annotations: {
    key: string;
    value: LocalAnnotation;
    indexes: { scoreId: string };
  };
  practiceLogs: {
    key: string;
    value: { repertoireItemId: string; logs: CachedPracticeLog[]; updatedAt: string };
  };
  calibrations: {
    key: string;
    value: DeviceCalibration;
    indexes: { deviceFingerprint: string };
  };
  remoteTempoMaps: {
    key: [string, string];
    value: RemoteTempoMap;
    indexes: {
      cacheOwnerId: string;
      ownerRepertoire: [string, string];
    };
  };
  remoteScores: {
    key: [string, string];
    value: RemoteScore;
    indexes: { ownerRepertoire: [string, string] };
  };
  remoteMeasureMaps: {
    key: [string, string];
    value: RemoteMeasureMap;
  };
  remoteAnnotations: {
    key: [string, string];
    value: RemoteAnnotation;
    indexes: { ownerScore: [string, string] };
  };
  remotePracticeLogs: {
    key: [string, string];
    value: {
      cacheOwnerId: string;
      repertoireItemId: string;
      logs: CachedPracticeLog[];
      updatedAt: string;
    };
  };
}

let databasePromise: Promise<IDBPDatabase<FmrDb>> | null = null;

function database(): Promise<IDBPDatabase<FmrDb>> {
  if (databasePromise) return databasePromise;
  const opening = openDB<FmrDb>('feelmyrythm', 3, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const tempoMaps = db.createObjectStore('tempoMaps', { keyPath: 'id' });
        tempoMaps.createIndex('repertoireItemId', 'repertoireItemId');
        const scores = db.createObjectStore('scores', { keyPath: 'id' });
        scores.createIndex('repertoireItemId', 'repertoireItemId');
        db.createObjectStore('measureMaps', { keyPath: 'scoreId' });
        const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
        annotations.createIndex('scoreId', 'scoreId');
        const calibrations = db.createObjectStore('calibrations', { keyPath: 'id' });
        calibrations.createIndex('deviceFingerprint', 'deviceFingerprint');
      }
      if (oldVersion < 2) {
        db.createObjectStore('practiceLogs', { keyPath: 'repertoireItemId' });
      }
      if (oldVersion < 3) {
        const remoteTempoMaps = db.createObjectStore('remoteTempoMaps', {
          keyPath: ['cacheOwnerId', 'id'],
        });
        remoteTempoMaps.createIndex('cacheOwnerId', 'cacheOwnerId');
        remoteTempoMaps.createIndex('ownerRepertoire', ['cacheOwnerId', 'repertoireItemId']);

        const remoteScores = db.createObjectStore('remoteScores', {
          keyPath: ['cacheOwnerId', 'id'],
        });
        remoteScores.createIndex('ownerRepertoire', ['cacheOwnerId', 'repertoireItemId']);
        db.createObjectStore('remoteMeasureMaps', {
          keyPath: ['cacheOwnerId', 'scoreId'],
        });
        const remoteAnnotations = db.createObjectStore('remoteAnnotations', {
          keyPath: ['cacheOwnerId', 'id'],
        });
        remoteAnnotations.createIndex('ownerScore', ['cacheOwnerId', 'scoreId']);
        db.createObjectStore('remotePracticeLogs', {
          keyPath: ['cacheOwnerId', 'repertoireItemId'],
        });

        // v1/v2 mixed local data and authenticated server snapshots in the same
        // stores. Remote rows had no owner marker, so they cannot be attributed
        // safely after an account switch. Preserve the explicitly local rows and
        // discard every unscoped remote snapshot before the v3 stores are used.
        void (async () => {
          const localScoreIds = new Set<string>();
          const legacyScores = transaction.objectStore('scores');
          let scoreCursor = await legacyScores.openCursor();
          while (scoreCursor) {
            if (
              typeof scoreCursor.value.id !== 'string' ||
              typeof scoreCursor.value.repertoireItemId !== 'string'
            ) {
              throw new Error('legacy score cache row is invalid');
            }
            if (scoreCursor.value.repertoireItemId === 'local') {
              localScoreIds.add(scoreCursor.value.id);
            } else {
              await scoreCursor.delete();
            }
            scoreCursor = await scoreCursor.continue();
          }

          const legacyTempoMaps = transaction.objectStore('tempoMaps');
          let tempoCursor = await legacyTempoMaps.openCursor();
          while (tempoCursor) {
            if (
              typeof tempoCursor.value.id !== 'string' ||
              typeof tempoCursor.value.repertoireItemId !== 'string'
            ) {
              throw new Error('legacy tempo-map cache row is invalid');
            }
            if (tempoCursor.value.repertoireItemId !== 'local') await tempoCursor.delete();
            tempoCursor = await tempoCursor.continue();
          }

          const legacyMeasureMaps = transaction.objectStore('measureMaps');
          let measureCursor = await legacyMeasureMaps.openCursor();
          while (measureCursor) {
            if (!localScoreIds.has(measureCursor.value.scoreId)) await measureCursor.delete();
            measureCursor = await measureCursor.continue();
          }

          const legacyAnnotations = transaction.objectStore('annotations');
          let annotationCursor = await legacyAnnotations.openCursor();
          while (annotationCursor) {
            if (!localScoreIds.has(annotationCursor.value.scoreId)) await annotationCursor.delete();
            annotationCursor = await annotationCursor.continue();
          }

          // The v2 practice-log store was only populated from authenticated REST
          // responses; anonymous practice data lives in localStorage.
          await transaction.objectStore('practiceLogs').clear();
        })().catch(() => {
          void transaction.done.catch(() => undefined);
          transaction.abort();
        });
      }
    },
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = null;
  });
  return opening;
}

function cacheOwner(scope: RemoteCacheScope): string {
  if (!scope.userId.trim()) throw new Error('remote cache requires a user id');
  return scope.userId;
}

function withoutCacheOwner<T>(value: T & { cacheOwnerId: string }): T {
  const { cacheOwnerId, ...record } = value;
  void cacheOwnerId;
  return record as T;
}

async function deleteRemoteStoreRows(
  db: IDBPDatabase<FmrDb>,
  storeName: RemoteCacheStoreName,
  ownerId: string,
): Promise<void> {
  const transaction = db.transaction(storeName, 'readwrite');
  let cursor = await transaction.store.openCursor();
  while (cursor) {
    const row = cursor.value as { cacheOwnerId: string };
    if (row.cacheOwnerId === ownerId) await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
}

export const localDb = {
  async deleteRemoteCache(scope: RemoteCacheScope): Promise<void> {
    const ownerId = cacheOwner(scope);
    const db = await database();
    await Promise.all(
      REMOTE_CACHE_STORES.map((storeName) => deleteRemoteStoreRows(db, storeName, ownerId)),
    );
  },
  async listTempoMaps(scope?: RemoteCacheScope): Promise<TempoMap[]> {
    if (scope) {
      const rows = await (
        await database()
      ).getAllFromIndex('remoteTempoMaps', 'cacheOwnerId', cacheOwner(scope));
      return rows.map((row) => withoutCacheOwner<TempoMap & { updatedAt?: string }>(row));
    }
    return (await database()).getAll('tempoMaps');
  },
  async getTempoMap(id: string, scope?: RemoteCacheScope): Promise<TempoMap | undefined> {
    if (scope) {
      const row = await (await database()).get('remoteTempoMaps', [cacheOwner(scope), id]);
      return row ? withoutCacheOwner<TempoMap & { updatedAt?: string }>(row) : undefined;
    }
    return (await database()).get('tempoMaps', id);
  },
  async getTempoMapForRepertoire(
    repertoireItemId: string,
    scope?: RemoteCacheScope,
  ): Promise<TempoMap | undefined> {
    const maps = scope
      ? (
          await (
            await database()
          ).getAllFromIndex('remoteTempoMaps', 'ownerRepertoire', [
            cacheOwner(scope),
            repertoireItemId,
          ])
        ).map((row) => withoutCacheOwner<TempoMap & { updatedAt?: string }>(row))
      : await (await database()).getAllFromIndex('tempoMaps', 'repertoireItemId', repertoireItemId);
    return maps.sort((left, right) => right.revision - left.revision)[0];
  },
  async putTempoMap(map: TempoMap, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (
        await database()
      ).put('remoteTempoMaps', {
        ...map,
        cacheOwnerId: cacheOwner(scope),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    await (
      await database()
    ).put('tempoMaps', {
      ...map,
      updatedAt: new Date().toISOString(),
    });
  },
  async deleteTempoMap(id: string, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (await database()).delete('remoteTempoMaps', [cacheOwner(scope), id]);
      return;
    }
    await (await database()).delete('tempoMaps', id);
  },
  async listScores(repertoireItemId = 'local', scope?: RemoteCacheScope): Promise<LocalScore[]> {
    if (scope) {
      const rows = await (
        await database()
      ).getAllFromIndex('remoteScores', 'ownerRepertoire', [cacheOwner(scope), repertoireItemId]);
      return rows.map((row) => withoutCacheOwner<LocalScore>(row));
    }
    return (await database()).getAllFromIndex('scores', 'repertoireItemId', repertoireItemId);
  },
  async putScore(score: LocalScore, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (await database()).put('remoteScores', { ...score, cacheOwnerId: cacheOwner(scope) });
      return;
    }
    await (await database()).put('scores', score);
  },
  async getScore(id: string, scope?: RemoteCacheScope): Promise<LocalScore | undefined> {
    if (scope) {
      const row = await (await database()).get('remoteScores', [cacheOwner(scope), id]);
      return row ? withoutCacheOwner<LocalScore>(row) : undefined;
    }
    return (await database()).get('scores', id);
  },
  async deleteScore(id: string, scope?: RemoteCacheScope): Promise<void> {
    const db = await database();
    if (scope) {
      const owner = cacheOwner(scope);
      const transaction = db.transaction(
        ['remoteScores', 'remoteMeasureMaps', 'remoteAnnotations'],
        'readwrite',
      );
      const annotationKeys = await transaction
        .objectStore('remoteAnnotations')
        .index('ownerScore')
        .getAllKeys([owner, id]);
      await Promise.all(
        annotationKeys.map((key) => transaction.objectStore('remoteAnnotations').delete(key)),
      );
      await Promise.all([
        transaction.objectStore('remoteScores').delete([owner, id]),
        transaction.objectStore('remoteMeasureMaps').delete([owner, id]),
      ]);
      await transaction.done;
      return;
    }
    const transaction = db.transaction(['scores', 'measureMaps', 'annotations'], 'readwrite');
    const annotationKeys = await transaction
      .objectStore('annotations')
      .index('scoreId')
      .getAllKeys(id);
    await Promise.all(
      annotationKeys.map((key) => transaction.objectStore('annotations').delete(key)),
    );
    await Promise.all([
      transaction.objectStore('scores').delete(id),
      transaction.objectStore('measureMaps').delete(id),
    ]);
    await transaction.done;
  },
  async putMeasureMap(map: LocalMeasureMap, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (
        await database()
      ).put('remoteMeasureMaps', { ...map, cacheOwnerId: cacheOwner(scope) });
      return;
    }
    await (await database()).put('measureMaps', map);
  },
  async getMeasureMap(
    scoreId: string,
    scope?: RemoteCacheScope,
  ): Promise<LocalMeasureMap | undefined> {
    if (scope) {
      const row = await (await database()).get('remoteMeasureMaps', [cacheOwner(scope), scoreId]);
      return row ? withoutCacheOwner<LocalMeasureMap>(row) : undefined;
    }
    return (await database()).get('measureMaps', scoreId);
  },
  async deleteMeasureMap(scoreId: string, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (await database()).delete('remoteMeasureMaps', [cacheOwner(scope), scoreId]);
      return;
    }
    await (await database()).delete('measureMaps', scoreId);
  },
  async listAnnotations(scoreId: string, scope?: RemoteCacheScope): Promise<LocalAnnotation[]> {
    if (scope) {
      const rows = await (
        await database()
      ).getAllFromIndex('remoteAnnotations', 'ownerScore', [cacheOwner(scope), scoreId]);
      return rows.map((row) => withoutCacheOwner<LocalAnnotation>(row));
    }
    return (await database()).getAllFromIndex('annotations', 'scoreId', scoreId);
  },
  async putAnnotation(annotation: LocalAnnotation, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (
        await database()
      ).put('remoteAnnotations', { ...annotation, cacheOwnerId: cacheOwner(scope) });
      return;
    }
    await (await database()).put('annotations', annotation);
  },
  async deleteAnnotation(id: string, scope?: RemoteCacheScope): Promise<void> {
    if (scope) {
      await (await database()).delete('remoteAnnotations', [cacheOwner(scope), id]);
      return;
    }
    await (await database()).delete('annotations', id);
  },
  async replaceAnnotations(
    scoreId: string,
    annotations: LocalAnnotation[],
    scope?: RemoteCacheScope,
  ): Promise<void> {
    const db = await database();
    if (scope) {
      const owner = cacheOwner(scope);
      const transaction = db.transaction('remoteAnnotations', 'readwrite');
      const existingKeys = await transaction.store.index('ownerScore').getAllKeys([owner, scoreId]);
      await Promise.all(existingKeys.map((key) => transaction.store.delete(key)));
      await Promise.all(
        annotations.map((annotation) =>
          transaction.store.put({ ...annotation, cacheOwnerId: owner }),
        ),
      );
      await transaction.done;
      return;
    }
    const transaction = db.transaction('annotations', 'readwrite');
    const existingKeys = await transaction.store.index('scoreId').getAllKeys(scoreId);
    await Promise.all(existingKeys.map((key) => transaction.store.delete(key)));
    await Promise.all(annotations.map((annotation) => transaction.store.put(annotation)));
    await transaction.done;
  },
  async putPracticeLogs(
    repertoireItemId: string,
    logs: CachedPracticeLog[],
    scope: RemoteCacheScope,
  ): Promise<void> {
    await (
      await database()
    ).put('remotePracticeLogs', {
      cacheOwnerId: cacheOwner(scope),
      repertoireItemId,
      logs,
      updatedAt: new Date().toISOString(),
    });
  },
  async getPracticeLogs(
    repertoireItemId: string,
    scope: RemoteCacheScope,
  ): Promise<CachedPracticeLog[]> {
    return (
      (await (await database()).get('remotePracticeLogs', [cacheOwner(scope), repertoireItemId]))
        ?.logs ?? []
    );
  },
  async getPracticeLogSnapshot(
    repertoireItemId: string,
    scope: RemoteCacheScope,
  ): Promise<{ logs: CachedPracticeLog[]; updatedAt: string } | undefined> {
    const snapshot = await (
      await database()
    ).get('remotePracticeLogs', [cacheOwner(scope), repertoireItemId]);
    return snapshot ? { logs: snapshot.logs, updatedAt: snapshot.updatedAt } : undefined;
  },
  async putCalibration(calibration: DeviceCalibration): Promise<void> {
    await (await database()).put('calibrations', calibration);
  },
  async listCalibrations(deviceFingerprint: string): Promise<DeviceCalibration[]> {
    return (await database()).getAllFromIndex(
      'calibrations',
      'deviceFingerprint',
      deviceFingerprint,
    );
  },
};

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const result = await navigator.storage?.estimate();
  if (!result?.quota) return null;
  return { usage: result.usage ?? 0, quota: result.quota };
}
