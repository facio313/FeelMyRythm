import type { TempoMap } from '@feelmyrythm/core';
import { deleteDB, openDB, type DBSchema } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  localDb,
  type CachedPracticeLog,
  type DeviceCalibration,
  type LocalAnnotation,
  type LocalMeasureMap,
  type LocalScore,
} from '../lib/localDb';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';

interface LegacyFmrDb extends DBSchema {
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
  measureMaps: { key: string; value: LocalMeasureMap };
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
}

const DB_NAME = 'feelmyrythm';
const USER_A = { userId: 'cache-user-a' } as const;
const USER_B = { userId: 'cache-user-b' } as const;

function openLegacyDatabase() {
  return openDB<LegacyFmrDb>(DB_NAME, 2, {
    upgrade(db) {
      const tempoMaps = db.createObjectStore('tempoMaps', { keyPath: 'id' });
      tempoMaps.createIndex('repertoireItemId', 'repertoireItemId');
      const scores = db.createObjectStore('scores', { keyPath: 'id' });
      scores.createIndex('repertoireItemId', 'repertoireItemId');
      db.createObjectStore('measureMaps', { keyPath: 'scoreId' });
      const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
      annotations.createIndex('scoreId', 'scoreId');
      const calibrations = db.createObjectStore('calibrations', { keyPath: 'id' });
      calibrations.createIndex('deviceFingerprint', 'deviceFingerprint');
      db.createObjectStore('practiceLogs', { keyPath: 'repertoireItemId' });
    },
  });
}

describe('offline storage', () => {
  it('aborts a broken v2 migration, then purges unscoped remote rows before v3 opens', async () => {
    await deleteDB(DB_NAME);
    let legacy = await openLegacyDatabase();
    await legacy.put('scores', { id: 'broken-cache-row' } as unknown as LocalScore);
    legacy.close();

    await expect(localDb.listTempoMaps()).rejects.toBeDefined();
    const afterAbort = await openDB(DB_NAME);
    expect(afterAbort.version).toBe(2);
    afterAbort.close();

    await deleteDB(DB_NAME);
    legacy = await openLegacyDatabase();
    const localMap = createDefaultTempoMap();
    const remoteMap = {
      ...createDefaultTempoMap('legacy-remote-repertoire'),
      id: 'legacy-remote-map',
    };
    const localScore: LocalScore = {
      id: 'legacy-local-score',
      repertoireItemId: 'local',
      name: 'local.pdf',
      kind: 'full',
      mimeType: 'application/pdf',
      blob: new Blob(['local']),
      updatedAt: new Date().toISOString(),
    };
    const remoteScore: LocalScore = {
      ...localScore,
      id: 'legacy-remote-score',
      repertoireItemId: 'legacy-remote-repertoire',
      name: 'remote.pdf',
      blob: new Blob(['remote']),
    };
    const localMeasureMap: LocalMeasureMap = {
      scoreId: localScore.id,
      measureNumberOffset: 0,
      regions: [],
      updatedAt: new Date().toISOString(),
    };
    const remoteMeasureMap = { ...localMeasureMap, scoreId: remoteScore.id };
    const localAnnotation: LocalAnnotation = {
      id: 'legacy-local-annotation',
      scoreId: localScore.id,
      scope: 'private',
      kind: 'text',
      page: 1,
      payload: { text: 'local' },
      updatedAt: new Date().toISOString(),
    };
    const remoteAnnotation: LocalAnnotation = {
      ...localAnnotation,
      id: 'legacy-remote-annotation',
      scoreId: remoteScore.id,
      payload: { text: 'remote' },
    };
    await Promise.all([
      legacy.put('tempoMaps', localMap),
      legacy.put('tempoMaps', remoteMap),
      legacy.put('scores', localScore),
      legacy.put('scores', remoteScore),
      legacy.put('measureMaps', localMeasureMap),
      legacy.put('measureMaps', remoteMeasureMap),
      legacy.put('annotations', localAnnotation),
      legacy.put('annotations', remoteAnnotation),
      legacy.put('practiceLogs', {
        repertoireItemId: remoteScore.repertoireItemId,
        logs: [],
        updatedAt: new Date().toISOString(),
      }),
    ]);
    legacy.close();

    await expect(localDb.getTempoMap(localMap.id)).resolves.toMatchObject({ id: localMap.id });
    await expect(localDb.getScore(localScore.id)).resolves.toMatchObject({ id: localScore.id });
    await expect(localDb.getMeasureMap(localScore.id)).resolves.toEqual(localMeasureMap);
    await expect(localDb.listAnnotations(localScore.id)).resolves.toEqual([localAnnotation]);
    await expect(localDb.getTempoMap(remoteMap.id)).resolves.toBeUndefined();
    await expect(localDb.getScore(remoteScore.id)).resolves.toBeUndefined();
    await expect(localDb.getMeasureMap(remoteScore.id)).resolves.toBeUndefined();
    await expect(localDb.listAnnotations(remoteScore.id)).resolves.toEqual([]);
    await expect(
      localDb.getPracticeLogSnapshot(remoteScore.repertoireItemId, USER_A),
    ).resolves.toBeUndefined();
  });

  it('round-trips a tempo map through IndexedDB', async () => {
    const map = createDefaultTempoMap();
    await localDb.putTempoMap(map);
    await expect(localDb.getTempoMap(map.id)).resolves.toMatchObject({
      id: map.id,
      revision: map.revision,
      totalMeasures: 64,
    });
  });

  it('returns the newest cached map for a repertoire item', async () => {
    const older = {
      ...createDefaultTempoMap('repertoire-cache'),
      id: crypto.randomUUID(),
      revision: 2,
    };
    const newer = { ...older, id: crypto.randomUUID(), revision: 4 };
    await localDb.putTempoMap(newer, USER_A);
    await localDb.putTempoMap(older, USER_A);
    await expect(
      localDb.getTempoMapForRepertoire('repertoire-cache', USER_A),
    ).resolves.toMatchObject({ id: newer.id, revision: 4 });
    await expect(
      localDb.getTempoMapForRepertoire('repertoire-cache', USER_B),
    ).resolves.toBeUndefined();
    await expect(localDb.listTempoMaps(USER_B)).resolves.not.toContainEqual(
      expect.objectContaining({ id: newer.id }),
    );
  });

  it('isolates remote score data and destructive operations by user', async () => {
    const scoreId = 'shared-remote-score-id';
    const repertoireItemId = 'shared-remote-repertoire-id';
    const scoreA: LocalScore = {
      id: scoreId,
      repertoireItemId,
      name: 'user-a.pdf',
      kind: 'full',
      mimeType: 'application/pdf',
      blob: new Blob(['user-a']),
      updatedAt: new Date().toISOString(),
    };
    const scoreB = { ...scoreA, name: 'user-b.pdf', blob: new Blob(['user-b']) };
    const mapA: LocalMeasureMap = {
      scoreId,
      measureNumberOffset: 1,
      regions: [],
      updatedAt: new Date().toISOString(),
    };
    const mapB = { ...mapA, measureNumberOffset: 2 };
    const annotationA: LocalAnnotation = {
      id: 'shared-remote-annotation-id',
      scoreId,
      scope: 'private',
      kind: 'text',
      page: 1,
      payload: { text: 'user-a' },
      updatedAt: new Date().toISOString(),
    };
    const annotationB = { ...annotationA, payload: { text: 'user-b' } };

    await Promise.all([
      localDb.putScore(scoreA, USER_A),
      localDb.putScore(scoreB, USER_B),
      localDb.putMeasureMap(mapA, USER_A),
      localDb.putMeasureMap(mapB, USER_B),
      localDb.putAnnotation(annotationA, USER_A),
      localDb.putAnnotation(annotationB, USER_B),
    ]);

    await expect(localDb.listScores(repertoireItemId, USER_A)).resolves.toMatchObject([
      { name: 'user-a.pdf' },
    ]);
    await expect(localDb.listScores(repertoireItemId, USER_B)).resolves.toMatchObject([
      { name: 'user-b.pdf' },
    ]);
    await expect(localDb.getMeasureMap(scoreId, USER_A)).resolves.toMatchObject({
      measureNumberOffset: 1,
    });
    await expect(localDb.getMeasureMap(scoreId, USER_B)).resolves.toMatchObject({
      measureNumberOffset: 2,
    });

    const replacementB = {
      ...annotationB,
      id: 'user-b-replacement-annotation',
      payload: { text: 'user-b-replaced' },
    };
    await localDb.replaceAnnotations(scoreId, [replacementB], USER_B);
    await expect(localDb.listAnnotations(scoreId, USER_A)).resolves.toEqual([annotationA]);
    await expect(localDb.listAnnotations(scoreId, USER_B)).resolves.toEqual([replacementB]);

    await localDb.deleteAnnotation(replacementB.id, USER_B);
    await expect(localDb.listAnnotations(scoreId, USER_B)).resolves.toEqual([]);
    await expect(localDb.listAnnotations(scoreId, USER_A)).resolves.toEqual([annotationA]);
    await localDb.putAnnotation(replacementB, USER_B);

    await localDb.deleteScore(scoreId, USER_B);
    await expect(localDb.getScore(scoreId, USER_B)).resolves.toBeUndefined();
    await expect(localDb.getMeasureMap(scoreId, USER_B)).resolves.toBeUndefined();
    await expect(localDb.listAnnotations(scoreId, USER_B)).resolves.toEqual([]);
    await expect(localDb.getScore(scoreId, USER_A)).resolves.toMatchObject({ name: 'user-a.pdf' });
    await expect(localDb.getMeasureMap(scoreId, USER_A)).resolves.toEqual(mapA);
    await expect(localDb.listAnnotations(scoreId, USER_A)).resolves.toEqual([annotationA]);
  });

  it('purges one account remote snapshots without touching another account or local data', async () => {
    const localMap = createDefaultTempoMap();
    const remoteMap = {
      ...createDefaultTempoMap('account-repertoire'),
      id: 'account-tempo-map',
    };
    const score: LocalScore = {
      id: 'account-score',
      repertoireItemId: 'account-repertoire',
      name: 'account.pdf',
      kind: 'full',
      mimeType: 'application/pdf',
      blob: new Blob(['score']),
      updatedAt: new Date().toISOString(),
    };
    const measureMap: LocalMeasureMap = {
      scoreId: score.id,
      measureNumberOffset: 0,
      regions: [],
      updatedAt: new Date().toISOString(),
    };
    const annotation: LocalAnnotation = {
      id: 'account-annotation',
      scoreId: score.id,
      scope: 'private',
      kind: 'text',
      page: 1,
      payload: { text: 'private account note' },
      updatedAt: new Date().toISOString(),
    };
    const practiceLog: CachedPracticeLog = {
      id: 'account-log',
      repertoireId: score.repertoireItemId,
      authorId: USER_A.userId,
      authorName: 'Account A',
      content: 'private practice note',
      anchors: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const calibration: DeviceCalibration = {
      id: 'local-calibration',
      deviceFingerprint: 'local-device',
      outputLabel: 'Built-in output',
      offsetMs: 0,
      samples: [0],
      updatedAt: new Date().toISOString(),
    };

    await Promise.all([
      localDb.putTempoMap(localMap),
      localDb.putCalibration(calibration),
      localDb.putTempoMap(remoteMap, USER_A),
      localDb.putTempoMap(remoteMap, USER_B),
      localDb.putScore(score, USER_A),
      localDb.putScore(score, USER_B),
      localDb.putMeasureMap(measureMap, USER_A),
      localDb.putMeasureMap(measureMap, USER_B),
      localDb.putAnnotation(annotation, USER_A),
      localDb.putAnnotation(annotation, USER_B),
      localDb.putPracticeLogs(score.repertoireItemId, [practiceLog], USER_A),
      localDb.putPracticeLogs(score.repertoireItemId, [practiceLog], USER_B),
    ]);

    await localDb.deleteRemoteCache(USER_A);

    await expect(localDb.getTempoMap(remoteMap.id, USER_A)).resolves.toBeUndefined();
    await expect(localDb.getScore(score.id, USER_A)).resolves.toBeUndefined();
    await expect(localDb.getMeasureMap(score.id, USER_A)).resolves.toBeUndefined();
    await expect(localDb.listAnnotations(score.id, USER_A)).resolves.toEqual([]);
    await expect(
      localDb.getPracticeLogSnapshot(score.repertoireItemId, USER_A),
    ).resolves.toBeUndefined();
    await expect(localDb.getTempoMap(remoteMap.id, USER_B)).resolves.toMatchObject({
      id: remoteMap.id,
    });
    await expect(localDb.getScore(score.id, USER_B)).resolves.toMatchObject({ id: score.id });
    await expect(localDb.getMeasureMap(score.id, USER_B)).resolves.toEqual(measureMap);
    await expect(localDb.listAnnotations(score.id, USER_B)).resolves.toEqual([annotation]);
    await expect(
      localDb.getPracticeLogSnapshot(score.repertoireItemId, USER_B),
    ).resolves.toMatchObject({ logs: [practiceLog] });
    await expect(localDb.getTempoMap(localMap.id)).resolves.toMatchObject({ id: localMap.id });
    await expect(localDb.listCalibrations(calibration.deviceFingerprint)).resolves.toEqual([
      calibration,
    ]);
  });

  it('replaces stale score annotations and removes stale measure maps', async () => {
    const scoreId = crypto.randomUUID();
    await localDb.putMeasureMap({
      scoreId,
      measureNumberOffset: 0,
      regions: [],
      updatedAt: new Date().toISOString(),
    });
    await localDb.putAnnotation({
      id: crypto.randomUUID(),
      scoreId,
      scope: 'private',
      kind: 'text',
      page: 1,
      payload: { text: 'stale' },
      updatedAt: new Date().toISOString(),
    });
    const replacement = {
      id: crypto.randomUUID(),
      scoreId,
      scope: 'project' as const,
      kind: 'stamp' as const,
      page: 2,
      payload: { text: 'new' },
      updatedAt: new Date().toISOString(),
    };

    await localDb.replaceAnnotations(scoreId, [replacement]);
    await localDb.deleteMeasureMap(scoreId);

    await expect(localDb.listAnnotations(scoreId)).resolves.toEqual([replacement]);
    await expect(localDb.getMeasureMap(scoreId)).resolves.toBeUndefined();
  });

  it('deletes a cached score together with its dependent offline data', async () => {
    const scoreId = crypto.randomUUID();
    const annotationId = crypto.randomUUID();
    await localDb.putScore({
      id: scoreId,
      repertoireItemId: 'repertoire-delete',
      name: 'part.pdf',
      kind: 'part',
      mimeType: 'application/pdf',
      blob: new Blob(['pdf']),
      updatedAt: new Date().toISOString(),
    });
    await localDb.putMeasureMap({
      scoreId,
      measureNumberOffset: 0,
      regions: [],
      updatedAt: new Date().toISOString(),
    });
    await localDb.putAnnotation({
      id: annotationId,
      scoreId,
      scope: 'private',
      kind: 'text',
      page: 1,
      payload: {},
      updatedAt: new Date().toISOString(),
    });

    await localDb.deleteScore(scoreId);

    await expect(localDb.getScore(scoreId)).resolves.toBeUndefined();
    await expect(localDb.getMeasureMap(scoreId)).resolves.toBeUndefined();
    await expect(localDb.listAnnotations(scoreId)).resolves.toEqual([]);
  });

  it('distinguishes an empty practice snapshot from no offline snapshot', async () => {
    await expect(localDb.getPracticeLogSnapshot('practice-empty', USER_A)).resolves.toBeUndefined();
    await expect(localDb.getPracticeLogSnapshot('practice-empty', USER_B)).resolves.toBeUndefined();

    await localDb.putPracticeLogs('practice-empty', [], USER_A);

    await expect(localDb.getPracticeLogSnapshot('practice-empty', USER_A)).resolves.toMatchObject({
      logs: [],
      updatedAt: expect.any(String),
    });
    await expect(localDb.getPracticeLogSnapshot('practice-empty', USER_B)).resolves.toBeUndefined();
  });
});
