import { describe, expect, it } from 'vitest';
import { practiceAnchorMarkers, type PracticeLogRecord } from './practiceApi';

const log: PracticeLogRecord = {
  id: 'log-1',
  repertoireId: 'repertoire-1',
  authorId: 'user-1',
  authorName: 'Violin',
  content: '26마디 crescendo 주의',
  anchors: [
    { measureNumber: 26 },
    { measureNumber: 28, scoreId: 'score-1', note: 'up bow' },
    { measureNumber: 30, scoreId: 'score-2' },
    { scoreId: 'score-1', page: 2, x: 0.25, y: 0.4, note: 'page note' },
    { page: 1 },
  ],
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
};

describe('practiceAnchorMarkers', () => {
  it('includes repertoire-wide and matching score anchors only', () => {
    expect(practiceAnchorMarkers([log], 'score-1')).toEqual([
      expect.objectContaining({ measureNumber: 26, content: log.content }),
      expect.objectContaining({ measureNumber: 28, content: 'up bow' }),
      expect.objectContaining({ page: 2, x: 0.25, y: 0.4, content: 'page note' }),
    ]);
  });
});
