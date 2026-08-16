import { assertValidTempoMap, type TempoMap } from '@feelmyrythm/core';
import type { ApiClient } from './api';
import { ApiError } from './api';
import type { LocalAnnotation, LocalMeasureMap, LocalScore } from './localDb';

export interface ScoreRecord {
  id: string;
  repertoireId: string;
  kind: 'full' | 'part';
  instrument: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  uploadStatus: 'pending' | 'ready';
  createdAt: string;
  updatedAt: string;
}

export interface ScoreListItem {
  id: string;
  repertoireItemId: string;
  name: string;
  kind: 'full' | 'part';
  instrument?: string;
  mimeType: string;
  updatedAt: string;
  uploadStatus: 'pending' | 'ready';
}

interface UploadTarget {
  scoreId: string;
  storageKey: string;
  uploadUrl: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  fields: Record<string, string>;
  expiresAt: string;
}

interface DownloadTarget {
  url: string;
  expiresAt: string;
}

interface MeasureMapRecord {
  id: string;
  scoreId: string;
  revision: number;
  regions: Array<{
    page: number;
    measureNumber: number;
    rect: { x: number; y: number; w: number; h: number };
  }>;
  measureNumberOffset: number;
  updatedAt: string;
}

interface ScoreSettingsRecord {
  score: ScoreRecord;
  measureMap: MeasureMapRecord;
}

export interface AnnotationRecord {
  id: string;
  scoreId: string;
  authorId: string;
  scope: 'private' | 'project';
  revision: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface VersionedMeasureMap {
  map: LocalMeasureMap;
  revision: number;
}

export interface VersionedAnnotation extends LocalAnnotation {
  revision?: number;
  authorId?: string;
}

export interface ScoreSettingsResult {
  score: ScoreRecord;
  measureMap: VersionedMeasureMap;
}

export interface MusicXmlDraft {
  title: string | null;
  totalMeasures: number;
  anacrusis?: { beats: number } | null;
  sections: Array<Record<string, unknown>>;
  jumps: Array<Record<string, unknown>>;
  countIn: Record<string, unknown>;
  warnings: string[];
}

export interface OmrDraft {
  id: string;
  scoreId: string;
  requestedById: string;
  expectedMeasureMapRevision: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  regions: Array<{
    page: number;
    measureNumber: number;
    rect: { x: number; y: number; w: number; h: number };
  }>;
  warnings: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const canonicalMeasureNumber = (
  scoreMeasure: number,
  measureNumberOffset: number,
): number | undefined => {
  const canonical = Math.trunc(scoreMeasure + measureNumberOffset);
  return canonical >= 1 ? canonical : undefined;
};

export const scoreMeasureNumber = (
  canonicalMeasure: number,
  measureNumberOffset: number,
): number | undefined => {
  const scoreMeasure = Math.trunc(canonicalMeasure - measureNumberOffset);
  return scoreMeasure >= 1 ? scoreMeasure : undefined;
};

export function tempoMapFromMusicXmlDraft(
  draft: MusicXmlDraft,
  repertoireItemId: string,
  revision = 0,
  id: string = crypto.randomUUID(),
): TempoMap {
  const candidate: unknown = {
    id,
    repertoireItemId,
    revision,
    totalMeasures: draft.totalMeasures,
    ...(draft.anacrusis ? { anacrusis: draft.anacrusis } : {}),
    sections: draft.sections.map((section, index) => ({
      ...section,
      id:
        typeof section.id === 'string' && section.id.trim()
          ? section.id
          : `musicxml-section-${index + 1}`,
      ...(index === 0 && draft.title && typeof section.label !== 'string'
        ? { label: draft.title }
        : {}),
    })),
    jumps: draft.jumps,
    countIn: draft.countIn,
  };
  assertValidTempoMap(candidate);
  return candidate;
}

const segment = (value: string): string => encodeURIComponent(value);

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response
    .json()
    .then((value: unknown) => value)
    .catch(() => null);
  if (typeof payload === 'object' && payload !== null) {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === 'string') return detail;
  }
  return response.statusText || fallback;
};

export function localScoreListItem(score: LocalScore): ScoreListItem {
  return {
    id: score.id,
    repertoireItemId: score.repertoireItemId,
    name: score.name,
    kind: score.kind,
    ...(score.instrument === undefined ? {} : { instrument: score.instrument }),
    mimeType: score.mimeType,
    updatedAt: score.updatedAt,
    uploadStatus: 'ready',
  };
}

export function scoreListItem(score: ScoreRecord): ScoreListItem {
  return {
    id: score.id,
    repertoireItemId: score.repertoireId,
    name: score.filename,
    kind: score.kind,
    ...(score.instrument ? { instrument: score.instrument } : {}),
    mimeType: score.contentType,
    updatedAt: score.updatedAt,
    uploadStatus: score.uploadStatus,
  };
}

export async function listScores(client: ApiClient, repertoireId: string): Promise<ScoreRecord[]> {
  return client.get<ScoreRecord[]>(`/repertoire/${segment(repertoireId)}/scores`);
}

export async function getScore(client: ApiClient, scoreId: string): Promise<ScoreRecord> {
  return client.get<ScoreRecord>(`/scores/${segment(scoreId)}`);
}

export async function updateScoreMetadata(
  client: ApiClient,
  scoreId: string,
  update: { kind: 'full' | 'part'; instrument: string },
): Promise<ScoreRecord> {
  return client.patch<ScoreRecord>(`/scores/${segment(scoreId)}`, update);
}

export async function updateScoreSettings(
  client: ApiClient,
  scoreId: string,
  update: {
    kind: 'full' | 'part';
    instrument: string;
    measureMap: LocalMeasureMap;
    expectedMeasureMapRevision: number;
  },
): Promise<ScoreSettingsResult> {
  const record = await client.put<ScoreSettingsRecord>(`/scores/${segment(scoreId)}/settings`, {
    kind: update.kind,
    instrument: update.instrument,
    expectedMeasureMapRevision: update.expectedMeasureMapRevision,
    regions: update.measureMap.regions.map(({ page, measureNumber, rect }) => ({
      page,
      measureNumber,
      rect,
    })),
    measureNumberOffset: update.measureMap.measureNumberOffset,
  });
  return { score: record.score, measureMap: measureMapFromRecord(record.measureMap) };
}

async function uploadToTarget(target: UploadTarget, blob: Blob, filename: string): Promise<void> {
  let response: Response;
  if (target.method === 'PUT') {
    response = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: target.headers,
      body: blob,
    });
  } else {
    const body = new FormData();
    Object.entries(target.fields).forEach(([key, value]) => body.append(key, value));
    body.append('file', blob, filename);
    response = await fetch(target.uploadUrl, {
      method: 'POST',
      headers: target.headers,
      body,
    });
  }
  if (!response.ok) {
    throw new Error(await errorMessage(response, `악보 원본 업로드 실패 (${response.status})`));
  }
}

export async function uploadScore(
  client: ApiClient,
  repertoireId: string,
  file: File,
  options: { contentType: string; kind: 'full' | 'part'; instrument?: string },
): Promise<ScoreRecord> {
  const target = await client.post<UploadTarget>(
    `/repertoire/${segment(repertoireId)}/scores/presign`,
    {
      filename: file.name,
      contentType: options.contentType,
      sizeBytes: file.size,
      kind: options.kind,
      instrument: options.instrument ?? '',
    },
  );
  try {
    await uploadToTarget(target, file, file.name);
    return await client.post<ScoreRecord>(`/scores/${segment(target.scoreId)}/complete`, {
      sizeBytes: file.size,
    });
  } catch (error) {
    await client.delete(`/scores/${segment(target.scoreId)}`).catch(() => undefined);
    throw error;
  }
}

export async function downloadScore(client: ApiClient, score: ScoreRecord): Promise<Blob> {
  const target = await client.get<DownloadTarget>(`/scores/${segment(score.id)}/download`);
  const response = await fetch(target.url);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `악보 다운로드 실패 (${response.status})`));
  }
  const downloaded = await response.blob();
  if (downloaded.type && downloaded.type !== 'application/octet-stream') return downloaded;
  return downloaded.slice(0, downloaded.size, score.contentType);
}

export async function getMeasureMap(
  client: ApiClient,
  scoreId: string,
): Promise<VersionedMeasureMap | undefined> {
  try {
    const record = await client.get<MeasureMapRecord>(`/scores/${segment(scoreId)}/measure-map`);
    return measureMapFromRecord(record);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

function measureMapFromRecord(record: MeasureMapRecord): VersionedMeasureMap {
  return {
    revision: record.revision,
    map: {
      scoreId: record.scoreId,
      measureNumberOffset: record.measureNumberOffset,
      regions: record.regions.map((region, index) => ({
        id: `${record.id}:${index}`,
        ...region,
      })),
      updatedAt: record.updatedAt,
    },
  };
}

export async function putMeasureMap(
  client: ApiClient,
  map: LocalMeasureMap,
  expectedRevision: number,
): Promise<VersionedMeasureMap> {
  const record = await client.put<MeasureMapRecord>(`/scores/${segment(map.scoreId)}/measure-map`, {
    expectedRevision,
    regions: map.regions.map(({ page, measureNumber, rect }) => ({ page, measureNumber, rect })),
    measureNumberOffset: map.measureNumberOffset,
  });
  return measureMapFromRecord(record);
}

export async function createOmrDraft(
  client: ApiClient,
  scoreId: string,
  expectedMeasureMapRevision: number,
): Promise<OmrDraft> {
  return client.post<OmrDraft>(`/scores/${segment(scoreId)}/omr-drafts`, {
    expectedMeasureMapRevision,
  });
}

export async function getOmrDraft(client: ApiClient, jobId: string): Promise<OmrDraft> {
  return client.get<OmrDraft>(`/omr-drafts/${segment(jobId)}`);
}

export function measureMapFromOmrDraft(draft: OmrDraft): LocalMeasureMap {
  if (draft.status !== 'succeeded') {
    throw new Error('완료되지 않은 OMR 작업은 마디 맵으로 바꿀 수 없습니다.');
  }
  return {
    scoreId: draft.scoreId,
    measureNumberOffset: 0,
    regions: draft.regions.map((region, index) => ({
      id: `${draft.id}:${index}`,
      ...region,
    })),
    updatedAt: draft.updatedAt,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function annotationFromRecord(record: AnnotationRecord): VersionedAnnotation {
  const kind =
    record.data.kind === 'pen' || record.data.kind === 'stamp' || record.data.kind === 'text'
      ? record.data.kind
      : 'text';
  const measureNumber = numberOr(record.data.measureNumber, Number.NaN);
  return {
    id: record.id,
    scoreId: record.scoreId,
    scope: record.scope,
    kind,
    page: Math.max(1, Math.trunc(numberOr(record.data.page, 1))),
    ...(Number.isFinite(measureNumber) && measureNumber >= 1
      ? { measureNumber: Math.trunc(measureNumber) }
      : {}),
    payload: isRecord(record.data.payload) ? record.data.payload : {},
    updatedAt: record.updatedAt,
    revision: record.revision,
    authorId: record.authorId,
  };
}

function annotationData(annotation: LocalAnnotation): Record<string, unknown> {
  return {
    kind: annotation.kind,
    page: annotation.page,
    ...(annotation.measureNumber === undefined ? {} : { measureNumber: annotation.measureNumber }),
    payload: annotation.payload,
  };
}

export async function listAnnotations(
  client: ApiClient,
  scoreId: string,
): Promise<VersionedAnnotation[]> {
  const records = await client.get<AnnotationRecord[]>(`/scores/${segment(scoreId)}/annotations`);
  return records.map(annotationFromRecord);
}

export async function listRepertoireAnnotations(
  client: ApiClient,
  repertoireId: string,
): Promise<VersionedAnnotation[]> {
  const records = await client.get<AnnotationRecord[]>(
    `/repertoire/${segment(repertoireId)}/annotations`,
  );
  return records.map(annotationFromRecord);
}

export async function createAnnotation(
  client: ApiClient,
  annotation: LocalAnnotation,
): Promise<VersionedAnnotation> {
  const record = await client.post<AnnotationRecord>(
    `/scores/${segment(annotation.scoreId)}/annotations`,
    { scope: annotation.scope, data: annotationData(annotation) },
  );
  return annotationFromRecord(record);
}

export async function updateAnnotation(
  client: ApiClient,
  annotation: VersionedAnnotation,
): Promise<VersionedAnnotation> {
  if (annotation.revision === undefined) {
    throw new Error('서버 필기 revision이 없어 수정할 수 없습니다. 목록을 새로고침해 주세요.');
  }
  const record = await client.put<AnnotationRecord>(`/annotations/${segment(annotation.id)}`, {
    expectedRevision: annotation.revision,
    data: annotationData(annotation),
  });
  return annotationFromRecord(record);
}

export async function deleteAnnotation(client: ApiClient, annotationId: string): Promise<void> {
  await client.delete(`/annotations/${segment(annotationId)}`);
}

export async function createMusicXmlDraft(
  client: ApiClient,
  repertoireId: string,
  file: File,
): Promise<MusicXmlDraft> {
  const body = new FormData();
  body.append('file', file, file.name);
  return client.request<MusicXmlDraft>(`/repertoire/${segment(repertoireId)}/musicxml/draft`, {
    method: 'POST',
    body,
  });
}
