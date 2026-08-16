import {
  assertValidTempoMap,
  beatsPerMeasure,
  type Accent,
  type JumpDirective,
  type TempoMap,
  type TempoMapValidationIssue,
  type TempoSection,
} from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';

type ServerTempoMap = components['schemas']['TempoMapOut'];
type JumpType = JumpDirective['type'];

export const JUMP_LABELS: Record<JumpType, string> = {
  repeat: '도돌이·볼타',
  dc: 'D.C.',
  ds: 'D.S.',
  coda: 'To Coda·Coda',
};

export const NOTE_VALUE_LABELS: Record<TempoSection['beatUnit'], string> = {
  whole: '온음표',
  dottedWhole: '점온음표',
  half: '2분음표',
  dottedHalf: '점2분음표',
  quarter: '4분음표',
  dottedQuarter: '점4분음표',
  eighth: '8분음표',
  dottedEighth: '점8분음표',
  sixteenth: '16분음표',
  dottedSixteenth: '점16분음표',
  thirtySecond: '32분음표',
};

export function fingerprint(map: TempoMap): string {
  return JSON.stringify(map);
}

/** Drop IndexedDB bookkeeping fields before revision/content reconciliation. */
export function tempoMapContract(map: TempoMap): TempoMap {
  const contract: TempoMap = {
    id: map.id,
    repertoireItemId: map.repertoireItemId,
    revision: map.revision,
    totalMeasures: map.totalMeasures,
    sections: map.sections,
    jumps: map.jumps,
    countIn: map.countIn,
    ...(map.anacrusis ? { anacrusis: map.anacrusis } : {}),
  };
  assertValidTempoMap(contract);
  return contract;
}

export function sectionDuration(section: TempoSection): number {
  return section.endMeasure - section.startMeasure + 1;
}

export function cloneSection(section: TempoSection): TempoSection {
  return {
    ...section,
    timeSignature: { ...section.timeSignature },
    ...(section.tempoChange ? { tempoChange: { ...section.tempoChange } } : {}),
    ...(section.accentPattern ? { accentPattern: [...section.accentPattern] } : {}),
  };
}

export function accentsFor(section: TempoSection, previous: Accent[] = []): Accent[] {
  const count = beatsPerMeasure(section);
  if (!Number.isInteger(count) || count < 1 || count > 64) return previous;
  return Array.from({ length: count }, (_, index) => previous[index] ?? (index === 0 ? 2 : 1));
}

export function updateSection(map: TempoMap, id: string, patch: Partial<TempoSection>): TempoMap {
  return {
    ...map,
    sections: map.sections
      .map((section) => (section.id === id ? { ...section, ...patch } : section))
      .sort((left, right) => left.startMeasure - right.startMeasure),
  };
}

export function updateSectionMeter(
  map: TempoMap,
  id: string,
  patch: Pick<Partial<TempoSection>, 'timeSignature' | 'beatUnit'>,
): TempoMap {
  return {
    ...map,
    sections: map.sections.map((section) => {
      if (section.id !== id) return section;
      const next = { ...section, ...patch };
      return { ...next, accentPattern: accentsFor(next, section.accentPattern) };
    }),
  };
}

/** Resize while keeping section coverage contiguous whenever the new value is usable. */
export function resizeTempoMap(map: TempoMap, totalMeasures: number): TempoMap {
  if (!Number.isInteger(totalMeasures) || totalMeasures < 1) return { ...map, totalMeasures };
  const sections = map.sections
    .filter((section) => section.startMeasure <= totalMeasures)
    .map((section) => ({ ...section, endMeasure: Math.min(section.endMeasure, totalMeasures) }));
  const last = sections.at(-1);
  if (last) last.endMeasure = totalMeasures;
  return { ...map, totalMeasures, sections };
}

/** Move a section's musical contents and duration, then recompute every contiguous boundary. */
export function moveTempoSection(map: TempoMap, id: string, direction: -1 | 1): TempoMap {
  const sections = map.sections.map(cloneSection);
  const index = sections.findIndex((section) => section.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sections.length) return map;
  const [moving] = sections.splice(index, 1);
  if (!moving) return map;
  sections.splice(target, 0, moving);
  let measure = 1;
  const repositioned = sections.map((section) => {
    const duration = sectionDuration(section);
    const next = { ...section, startMeasure: measure, endMeasure: measure + duration - 1 };
    measure = next.endMeasure + 1;
    return next;
  });
  return { ...map, sections: repositioned };
}

export function splitTempoSection(
  map: TempoMap,
  id: string,
  splitMeasure: number,
  newId: string,
): TempoMap {
  const selected = map.sections.find((section) => section.id === id);
  if (!selected || splitMeasure <= selected.startMeasure || splitMeasure > selected.endMeasure) {
    throw new Error('선택한 구간 안의 나눌 마디를 입력하세요.');
  }
  const next: TempoSection = {
    ...cloneSection(selected),
    id: newId,
    label: selected.label ? `${selected.label} 2` : 'New',
    startMeasure: splitMeasure,
  };
  return {
    ...map,
    sections: map.sections
      .map((section) =>
        section.id === selected.id ? { ...section, endMeasure: splitMeasure - 1 } : section,
      )
      .concat(next)
      .sort((left, right) => left.startMeasure - right.startMeasure),
  };
}

export function mergeTempoSectionWithPrevious(map: TempoMap, id: string): TempoMap {
  const index = map.sections.findIndex((section) => section.id === id);
  const selected = map.sections[index];
  const previous = map.sections[index - 1];
  if (!selected || !previous) return map;
  return {
    ...map,
    sections: map.sections
      .filter((section) => section.id !== selected.id)
      .map((section) =>
        section.id === previous.id ? { ...section, endMeasure: selected.endMeasure } : section,
      ),
  };
}

export function deleteTempoSection(
  map: TempoMap,
  id: string,
): { map: TempoMap; selectedId: string } {
  if (map.sections.length <= 1) return { map, selectedId: id };
  const index = map.sections.findIndex((section) => section.id === id);
  const selected = map.sections[index];
  const replacement = map.sections[index - 1] ?? map.sections[index + 1];
  if (!selected || !replacement) return { map, selectedId: id };
  return {
    selectedId: replacement.id,
    map: {
      ...map,
      sections: map.sections
        .filter((section) => section.id !== selected.id)
        .map((section) =>
          section.id === replacement.id
            ? {
                ...section,
                startMeasure: Math.min(section.startMeasure, selected.startMeasure),
                endMeasure: Math.max(section.endMeasure, selected.endMeasure),
              }
            : section,
        )
        .sort((left, right) => left.startMeasure - right.startMeasure),
    },
  };
}

/** Return a rounded BPM from the most recent uninterrupted tap series. */
export function calculateTapTempo(timestampsMs: readonly number[]): number | null {
  if (timestampsMs.length < 2) return null;
  const recent = timestampsMs.slice(-8);
  let start = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const interval = (recent[index] ?? 0) - (recent[index - 1] ?? 0);
    if (interval > 2_000 || interval <= 0) start = index;
  }
  const series = recent.slice(start);
  if (series.length < 2) return null;
  const intervals = series.slice(1).map((time, index) => time - (series[index] ?? time));
  const average = intervals.reduce((total, interval) => total + interval, 0) / intervals.length;
  return Math.max(20, Math.min(400, Math.round(60_000 / average)));
}

export function tempoMapFromServer(response: ServerTempoMap, repertoireItemId: string): TempoMap {
  const candidate: unknown = {
    ...response.data,
    id: response.data.id || response.id,
    repertoireItemId,
    revision: response.revision,
  };
  assertValidTempoMap(candidate);
  return candidate;
}

export function isNetworkFailure(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

export function createJump(type: JumpType, map: TempoMap, section: TempoSection): JumpDirective {
  if (type === 'repeat') {
    return {
      type,
      startMeasure: section.startMeasure,
      endMeasure: section.endMeasure,
      times: 2,
    };
  }
  if (type === 'dc') return { type, atMeasure: section.endMeasure };
  if (type === 'ds') {
    return { type, atMeasure: section.endMeasure, segnoMeasure: section.startMeasure };
  }
  const toCodaMeasure = section.startMeasure;
  const codaMeasure = toCodaMeasure === map.totalMeasures ? 1 : map.totalMeasures;
  return { type, toCodaMeasure, codaMeasure };
}

export function updateJump(map: TempoMap, index: number, jump: JumpDirective): TempoMap {
  return {
    ...map,
    jumps: map.jumps.map((current, currentIndex) => (currentIndex === index ? jump : current)),
  };
}

export function friendlyIssue(issue: TempoMapValidationIssue): string {
  const fallbacks: Record<TempoMapValidationIssue['code'], string> = {
    required: '필수 값을 입력하세요.',
    range: '곡과 반복 범위 안의 값을 입력하세요.',
    integer: '허용된 정수를 입력하세요.',
    order: '시작보다 끝이 빠를 수 없습니다.',
    coverage: '모든 마디를 빈틈이나 겹침 없이 한 번씩 포함해야 합니다.',
    duplicate: '중복 값을 제거하세요.',
    meter: '박자표와 박 단위가 한 마디를 정확히 나누도록 수정하세요.',
    tempo: 'BPM과 rit./accel. 목표의 방향을 확인하세요.',
    accent: '강세 수를 해당 박자의 박 수와 맞추고 0–2만 사용하세요.',
    jump: '이동 마디와 Fine/Coda 연결을 곡 범위 안에서 완성하세요.',
    ambiguous: '서로 겹치거나 중복되는 진행 지시를 정리하세요.',
  };
  return fallbacks[issue.code];
}

export function issueFor(
  issues: readonly TempoMapValidationIssue[],
  path: string,
  descendants = false,
): string | undefined {
  const matches = issues.filter(
    (issue) =>
      issue.path === path ||
      (descendants && (issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`))),
  );
  if (matches.length === 0) return undefined;
  return [...new Set(matches.map(friendlyIssue))].join(' ');
}
