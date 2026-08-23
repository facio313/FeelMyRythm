import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScoreRecord } from '../lib/scoreApi';
import { mergeRemoteScoreMetadata, omrDraftCreationAvailableInCurrentBuild } from './ScoresPage';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe('OMR build availability', () => {
  it('keeps OMR draft creation out of the managed-local SSO build', () => {
    vi.stubEnv('VITE_FMR_MANAGED_LOCAL_SSO', 'true');

    expect(omrDraftCreationAvailableInCurrentBuild()).toBe(false);
  });

  it('keeps the future standard OMR path available', () => {
    vi.stubEnv('VITE_FMR_MANAGED_LOCAL_SSO', 'false');

    expect(omrDraftCreationAvailableInCurrentBuild()).toBe(true);
  });
});
