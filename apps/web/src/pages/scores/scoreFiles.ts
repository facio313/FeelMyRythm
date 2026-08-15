import type { LocalMeasureMap, LocalScore } from '../../lib/localDb';
import { readMusicXml } from '../../lib/musicxml';
import type { ScoreRecord } from '../../lib/scoreApi';

export const MUSIC_XML_MIME = 'application/vnd.recordare.musicxml+xml';

export const isMusicXmlName = (name: string): boolean => /\.(?:musicxml|mxl|xml)$/i.test(name);

export function scoreContentType(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mxl')) return 'application/zip';
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return MUSIC_XML_MIME;
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return file.type;
}

export function supportsScore(file: File, contentType: string): boolean {
  return (
    contentType === 'application/pdf' ||
    contentType.startsWith('image/') ||
    contentType.includes('musicxml') ||
    isMusicXmlName(file.name)
  );
}

export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load/i.test(error.message);
}

export function nextMeasureNumber(map?: LocalMeasureMap): number {
  return Math.max(0, ...(map?.regions.map((region) => region.measureNumber) ?? [])) + 1;
}

export function draftSectionSummary(section: Record<string, unknown>, index: number): string {
  const start = Number(section.startMeasure);
  const end = Number(section.endMeasure);
  const bpm = Number(section.bpm);
  const signature = section.timeSignature;
  const signatureRecord =
    typeof signature === 'object' && signature !== null
      ? (signature as Record<string, unknown>)
      : undefined;
  const num = signatureRecord?.num;
  const denom = signatureRecord?.denom;
  const meter = `${typeof num === 'number' || typeof num === 'string' ? num : '?'}/${
    typeof denom === 'number' || typeof denom === 'string' ? denom : '?'
  }`;
  return `구간 ${index + 1}: ${Number.isFinite(start) ? start : '?'}–${Number.isFinite(end) ? end : '?'}마디 · ${meter} · ${Number.isFinite(bpm) ? bpm : '?'} BPM`;
}

export function draftJumpSummary(jump: Record<string, unknown>, index: number): string {
  const type = typeof jump.type === 'string' ? jump.type : `이동 ${index + 1}`;
  const details = ['startMeasure', 'endMeasure', 'fromMeasure', 'targetMeasure', 'times', 'pass']
    .flatMap((key) =>
      typeof jump[key] === 'number' || typeof jump[key] === 'string'
        ? [`${key} ${String(jump[key])}`]
        : [],
    )
    .join(' · ');
  return details ? `${type} · ${details}` : type;
}

function localScoreWithMetadata(record: ScoreRecord, blob: Blob, mimeType: string): LocalScore {
  return {
    id: record.id,
    repertoireItemId: record.repertoireId,
    name: record.filename,
    kind: record.kind,
    ...(record.instrument ? { instrument: record.instrument } : {}),
    mimeType,
    blob,
    updatedAt: record.updatedAt,
  };
}

export async function localScoreFromRemote(
  record: ScoreRecord,
  downloaded: Blob,
): Promise<LocalScore> {
  let blob = downloaded;
  let mimeType = record.contentType;
  if (isMusicXmlName(record.filename)) {
    const source = new File([downloaded], record.filename, { type: record.contentType });
    const xml = await readMusicXml(source);
    blob = new Blob([xml], { type: MUSIC_XML_MIME });
    mimeType = MUSIC_XML_MIME;
  }
  return localScoreWithMetadata(record, blob, mimeType);
}

export function mergeRemoteScoreMetadata(record: ScoreRecord, score: LocalScore): LocalScore {
  return localScoreWithMetadata(record, score.blob, score.mimeType);
}
