import type { ApiClient } from './api';

export interface PracticeAnchor {
  measureNumber?: number;
  scoreId?: string;
  page?: number;
  x?: number;
  y?: number;
  note?: string;
}

export interface PracticeLogRecord {
  id: string;
  repertoireId: string;
  authorId: string;
  authorName: string;
  content: string;
  anchors: PracticeAnchor[];
  createdAt: string;
  updatedAt: string;
}

export interface PracticeAnchorMarker extends PracticeAnchor {
  logId: string;
  authorName: string;
  content: string;
}

const segment = (value: string): string => encodeURIComponent(value);

export async function listPracticeLogs(
  client: ApiClient,
  repertoireItemId: string,
): Promise<PracticeLogRecord[]> {
  return client.get<PracticeLogRecord[]>(`/repertoire/${segment(repertoireItemId)}/logs`);
}

/**
 * Resolve score-visible anchors. A score-specific anchor only appears on that
 * score; a measure-only anchor is shared by every part of the repertoire.
 */
export function practiceAnchorMarkers(
  logs: PracticeLogRecord[],
  scoreId: string,
): PracticeAnchorMarker[] {
  return logs.flatMap((log) =>
    log.anchors
      .filter((anchor) => {
        if (anchor.scoreId && anchor.scoreId !== scoreId) return false;
        const hasMeasure = anchor.measureNumber !== undefined;
        const hasPagePosition =
          anchor.scoreId === scoreId &&
          anchor.page !== undefined &&
          anchor.x !== undefined &&
          anchor.y !== undefined;
        return hasMeasure || hasPagePosition;
      })
      .map((anchor) => ({
        ...anchor,
        logId: log.id,
        authorName: log.authorName,
        content: anchor.note?.trim() || log.content,
      })),
  );
}
