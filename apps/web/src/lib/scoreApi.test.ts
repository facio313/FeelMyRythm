import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api';
import {
  canonicalMeasureNumber,
  createOmrDraft,
  deleteAnnotation,
  getMeasureMap,
  listAnnotations,
  listRepertoireAnnotations,
  measureMapFromOmrDraft,
  putMeasureMap,
  scoreMeasureNumber,
  tempoMapFromMusicXmlDraft,
  updateAnnotation,
  updateScoreMetadata,
  updateScoreSettings,
  uploadScore,
  type ScoreRecord,
} from './scoreApi';

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const score: ScoreRecord = {
  id: 'score-1',
  repertoireId: 'repertoire-1',
  kind: 'full',
  instrument: '',
  filename: 'score.pdf',
  contentType: 'application/pdf',
  sizeBytes: 3,
  uploadStatus: 'ready',
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
};

const client = (): ApiClient =>
  new ApiClient(
    () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'bearer',
      expiresIn: 3600,
    }),
    () => undefined,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('score API', () => {
  it('keeps a canonical measure while switching scores with numbering offsets', () => {
    expect(canonicalMeasureNumber(1, 10)).toBe(11);
    expect(scoreMeasureNumber(11, 10)).toBe(1);
    expect(scoreMeasureNumber(5, 10)).toBeUndefined();
    expect(canonicalMeasureNumber(1, -1)).toBeUndefined();
    expect(canonicalMeasureNumber(2, -1)).toBe(1);
  });
  it('turns a server MusicXML draft into a validated TempoMap', () => {
    const map = tempoMapFromMusicXmlDraft(
      {
        title: 'Etude',
        totalMeasures: 2,
        anacrusis: { beats: 1 },
        sections: [
          {
            startMeasure: 1,
            endMeasure: 2,
            timeSignature: { num: 6, denom: 8 },
            bpm: 72,
            beatUnit: 'dottedQuarter',
          },
        ],
        jumps: [{ type: 'repeat', startMeasure: 1, endMeasure: 2, times: 2 }],
        countIn: { measures: 1, useSectionMeter: true },
        warnings: [],
      },
      'repertoire-1',
      3,
      'map-1',
    );
    expect(map).toMatchObject({
      id: 'map-1',
      repertoireItemId: 'repertoire-1',
      revision: 3,
      totalMeasures: 2,
      anacrusis: { beats: 1 },
    });
    expect(map.sections[0]).toMatchObject({ label: 'Etude', bpm: 72 });
  });

  it('updates score kind and instrument metadata', async () => {
    const updated = { ...score, kind: 'part' as const, instrument: 'Violin' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateScoreMetadata(client(), score.id, { kind: 'part', instrument: 'Violin' }),
    ).resolves.toEqual(updated);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ kind: 'part', instrument: 'Violin' }),
    );
  });

  it('updates score metadata and its measure map in one revision-checked request', async () => {
    const updated = { ...score, kind: 'part' as const, instrument: 'Violin' };
    const mapRecord = {
      id: 'map-1',
      scoreId: score.id,
      revision: 5,
      regions: [{ page: 1, measureNumber: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.2 } }],
      measureNumberOffset: 10,
      updatedAt: '2026-08-14T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ score: updated, measureMap: mapRecord }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateScoreSettings(client(), score.id, {
      kind: 'part',
      instrument: 'Violin',
      measureMap: {
        scoreId: score.id,
        measureNumberOffset: 10,
        regions: [{ id: 'ui-only', ...mapRecord.regions[0]! }],
        updatedAt: mapRecord.updatedAt,
      },
      expectedMeasureMapRevision: 4,
    });

    expect(result.score).toEqual(updated);
    expect(result.measureMap.revision).toBe(5);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        kind: 'part',
        instrument: 'Violin',
        expectedMeasureMapRevision: 4,
        regions: mapRecord.regions,
        measureNumberOffset: 10,
      }),
    );
  });

  it('presigns, performs an unauthenticated raw PUT with returned headers, then completes', async () => {
    const file = new File(['pdf'], 'score.pdf', { type: 'application/pdf' });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            scoreId: score.id,
            storageKey: 'scores/score.pdf',
            uploadUrl: 'https://uploads.example/score.pdf',
            method: 'PUT',
            headers: { 'Content-Type': 'application/pdf', 'x-upload-token': 'signed' },
            fields: {},
            expiresAt: '2026-08-14T00:10:00Z',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(score));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadScore(client(), score.repertoireId, file, {
        contentType: file.type,
        kind: 'full',
      }),
    ).resolves.toEqual(score);

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://uploads.example/score.pdf', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'x-upload-token': 'signed' },
      body: file,
    });
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ sizeBytes: file.size }));
  });

  it('removes a pending score when its raw upload fails', async () => {
    const file = new File(['pdf'], 'score.pdf', { type: 'application/pdf' });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            scoreId: score.id,
            storageKey: 'scores/score.pdf',
            uploadUrl: 'https://uploads.example/score.pdf',
            method: 'PUT',
            headers: {},
            fields: {},
            expiresAt: '2026-08-14T00:10:00Z',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response('upload failed', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadScore(client(), score.repertoireId, file, {
        contentType: file.type,
        kind: 'full',
      }),
    ).rejects.toThrow('악보 원본 업로드 실패 (500)');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('deletes an annotation through its canonical endpoint', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteAnnotation(client(), 'annotation-1');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/annotations/annotation-1');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('carries the measure-map revision into the next write and omits UI-only region ids', async () => {
    const current = {
      id: 'map-1',
      scoreId: score.id,
      revision: 4,
      regions: [{ page: 1, measureNumber: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.2 } }],
      measureNumberOffset: 0,
      updatedAt: '2026-08-14T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(current))
      .mockResolvedValueOnce(jsonResponse({ ...current, revision: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await getMeasureMap(client(), score.id);
    expect(loaded?.revision).toBe(4);
    if (!loaded) throw new Error('measure map fixture was not loaded');
    await putMeasureMap(client(), loaded.map, loaded.revision);

    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        expectedRevision: 4,
        regions: current.regions,
        measureNumberOffset: 0,
      }),
    );
  });

  it('starts an OMR job with the current map revision and converts only a completed draft', async () => {
    const draft = {
      id: 'omr-1',
      scoreId: score.id,
      requestedById: 'leader-1',
      expectedMeasureMapRevision: 4,
      status: 'succeeded' as const,
      regions: [{ page: 1, measureNumber: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }],
      warnings: ['best effort'],
      error: null,
      createdAt: '2026-08-15T00:00:00Z',
      updatedAt: '2026-08-15T00:00:01Z',
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(draft, 202));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createOmrDraft(client(), score.id, 4)).resolves.toEqual(draft);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedMeasureMapRevision: 4 }),
    );
    expect(measureMapFromOmrDraft(draft)).toEqual({
      scoreId: score.id,
      measureNumberOffset: 0,
      regions: [{ id: 'omr-1:0', ...draft.regions[0]! }],
      updatedAt: draft.updatedAt,
    });
    expect(() => measureMapFromOmrDraft({ ...draft, status: 'running' })).toThrow(
      '완료되지 않은 OMR 작업',
    );
  });

  it('lists annotation revisions and sends expectedRevision on update', async () => {
    const annotation = {
      id: 'annotation-1',
      scoreId: score.id,
      authorId: 'user-1',
      scope: 'private',
      revision: 2,
      data: {
        kind: 'text',
        page: 1,
        measureNumber: 3,
        payload: { x: 0.2, y: 0.4, text: 'crescendo' },
      },
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([annotation]))
      .mockResolvedValueOnce(jsonResponse({ ...annotation, revision: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    const [loaded] = await listAnnotations(client(), score.id);
    if (!loaded) throw new Error('annotation fixture was not loaded');
    const updated = await updateAnnotation(client(), loaded);

    expect(updated.revision).toBe(3);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ expectedRevision: 2, data: annotation.data }),
    );
  });

  it('lists visible annotations across every score in a repertoire', async () => {
    const record = {
      id: 'annotation-cross-part',
      scoreId: 'score-2',
      authorId: 'user-1',
      scope: 'project',
      revision: 1,
      data: {
        kind: 'text',
        page: 1,
        measureNumber: 12,
        payload: { anchorType: 'measure', text: 'shared bowing' },
      },
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    } as const;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse([record]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listRepertoireAnnotations(client(), 'repertoire-1')).resolves.toEqual([
      expect.objectContaining({ scoreId: 'score-2', measureNumber: 12 }),
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/repertoire/repertoire-1/annotations');
  });
});
