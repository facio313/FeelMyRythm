import { describe, expect, it } from 'vitest';
import type { ScoreRecord } from '../lib/scoreApi';
import { mergeRemoteScoreMetadata } from './scores/scoreFiles';

describe('remote score normalization', () => {
  it('does not try to unzip an already-normalized MXL snapshot after metadata changes', async () => {
    const record: ScoreRecord = {
      id: 'score-mxl',
      repertoireId: 'repertoire-mxl',
      kind: 'part',
      instrument: 'Violin',
      filename: 'part.mxl',
      contentType: 'application/zip',
      sizeBytes: 42,
      uploadStatus: 'ready',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T01:00:00.000Z',
    };
    const normalized = new Blob(['<score-partwise />'], {
      type: 'application/vnd.recordare.musicxml+xml',
    });

    const score = mergeRemoteScoreMetadata(record, {
      id: record.id,
      repertoireItemId: record.repertoireId,
      name: record.filename,
      kind: 'full',
      mimeType: normalized.type,
      blob: normalized,
      updatedAt: record.createdAt,
    });

    expect(score.blob).toBe(normalized);
    expect(score.mimeType).toBe('application/vnd.recordare.musicxml+xml');
    expect(score.name).toBe('part.mxl');
  });
});
