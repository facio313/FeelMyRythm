import { FileMusic, FileText } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { ScoreListItem } from '../../lib/scoreApi';

export function ScorePartTabs({
  parts,
  selectedId,
  onSelect,
  onKeyDown,
}: {
  parts: readonly ScoreListItem[];
  selectedId?: string | undefined;
  onSelect: (scoreId: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  return (
    <div className="score-parts" role="tablist" aria-label="총보와 파트보">
      {parts.map((score, index) => (
        <button
          key={score.id}
          id={`score-part-tab-${score.id}`}
          role="tab"
          aria-selected={selectedId === score.id}
          aria-controls="score-part-panel"
          tabIndex={selectedId === score.id ? 0 : -1}
          className={selectedId === score.id ? 'score-part--active' : ''}
          onClick={() => onSelect(score.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {score.kind === 'full' ? (
            <FileMusic size={16} aria-hidden />
          ) : (
            <FileText size={16} aria-hidden />
          )}
          {score.instrument ?? (score.kind === 'full' ? '총보' : score.name)}
        </button>
      ))}
    </div>
  );
}
