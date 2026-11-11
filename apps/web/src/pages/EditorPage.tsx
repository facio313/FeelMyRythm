import {
  assertValidTempoMap,
  beatsPerMeasure,
  expandTimeline,
  tempoAtMeasureStart,
  validateTempoMap,
  type Accent,
  type JumpDirective,
  type MeasureExpression,
  type TempoMap,
  type TempoMapValidationIssue,
  type TempoSection,
  type VoltaEnding,
} from '@feelmyrythm/core';
import type { components } from '@feelmyrythm/protocol';
import { Button, Card, Field, Modal, StatusBadge, useToast } from '@feelmyrythm/ui';
import {
  BookOpen,
  Braces,
  ChevronDown,
  ChevronUp,
  Download,
  GitMerge,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  useBeforeUnload,
  useBlocker,
  useNavigate,
  useParams,
  useSearchParams,
  type BlockerFunction,
} from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { createDefaultTempoMap } from '../lib/defaultTempoMap';
import { localDb } from '../lib/localDb';
import { rebaseTempoMapDraft } from '../lib/tempoMapMerge';

type ServerTempoMap = components['schemas']['TempoMapOut'];
type JumpType = JumpDirective['type'];

interface LoadConflict {
  local: TempoMap;
  server: TempoMap;
}

interface SaveConflict {
  draft: TempoMap;
  latest: TempoMap;
  rebased: TempoMap;
}

interface UndoDelete {
  map: TempoMap;
  selectedId: string;
  label: string;
}

const JUMP_LABELS: Record<JumpType, string> = {
  repeat: '도돌이·볼타',
  dc: 'D.C.',
  ds: 'D.S.',
  coda: 'To Coda·Coda',
};

const NOTE_VALUE_LABELS: Record<TempoSection['beatUnit'], string> = {
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

function fingerprint(map: TempoMap): string {
  return JSON.stringify(map);
}

/** Drop IndexedDB bookkeeping fields before revision/content reconciliation. */
function tempoMapContract(map: TempoMap): TempoMap {
  const contract: TempoMap = {
    id: map.id,
    repertoireItemId: map.repertoireItemId,
    revision: map.revision,
    totalMeasures: map.totalMeasures,
    sections: map.sections,
    jumps: map.jumps,
    countIn: map.countIn,
    ...(map.anacrusis ? { anacrusis: map.anacrusis } : {}),
    ...(map.measureExpressions ? { measureExpressions: map.measureExpressions } : {}),
  };
  assertValidTempoMap(contract);
  return contract;
}

function sectionDuration(section: TempoSection): number {
  return section.endMeasure - section.startMeasure + 1;
}

function cloneSection(section: TempoSection): TempoSection {
  return {
    ...section,
    timeSignature: { ...section.timeSignature },
    ...(section.tempoChange ? { tempoChange: { ...section.tempoChange } } : {}),
    ...(section.fermata ? { fermata: { ...section.fermata } } : {}),
    ...(section.breath ? { breath: { ...section.breath } } : {}),
    ...(section.accentPattern ? { accentPattern: [...section.accentPattern] } : {}),
  };
}

function restoredTempo(map: TempoMap, selected: TempoSection): number {
  if (validateTempoMap(map).valid) return restoredTempoAtMeasure(map, selected.startMeasure);
  const index = map.sections.findIndex((section) => section.id === selected.id);
  const preceding = map.sections.slice(0, index);
  const ramp = preceding.findLast(
    (section) => section.tempoChange?.type === 'rit' || section.tempoChange?.type === 'accel',
  );
  const previous = preceding.at(-1);
  return (
    ramp?.bpm ??
    (previous?.tempoChange?.type === 'aTempo' ? previous.tempoChange.targetBpm : previous?.bpm) ??
    selected.bpm
  );
}

function sectionExpressionSummary(section: TempoSection): string {
  const expressions: string[] = [];
  if (section.tempoChange) {
    const { type, targetBpm } = section.tempoChange;
    expressions.push(
      type === 'aTempo'
        ? `아 템포 ${targetBpm}`
        : `${type === 'rit' ? '리타르단도' : '아첼레란도'} ${section.bpm} → ${targetBpm}`,
    );
  }
  if (section.fermata) {
    expressions.push(
      `페르마타 ${section.fermata.beat ? `${section.fermata.beat}박 · ` : ''}+${section.fermata.extraBeats}박`,
    );
  }
  if (section.breath) {
    expressions.push(
      `쉼표 ${section.breath.durationSec}초 · 예비박 ${section.breath.countIn ? '켬' : '끔'}`,
    );
  }
  return expressions.join(' · ');
}

function sectionBpm(section: TempoSection): number {
  return section.tempoChange?.type === 'aTempo' ? section.tempoChange.targetBpm : section.bpm;
}

function updateMeasureExpression(
  map: TempoMap,
  index: number,
  expression: MeasureExpression,
): TempoMap {
  return {
    ...map,
    measureExpressions:
      map.measureExpressions?.map((current, currentIndex) =>
        currentIndex === index ? expression : current,
      ) ?? [],
  };
}

function withoutMeasureTempo(expression: MeasureExpression): MeasureExpression {
  const next = { ...expression };
  delete next.tempoChange;
  return next;
}

function restoredTempoAtMeasure(map: TempoMap, measure: number): number {
  const measureTempoSpans = (map.measureExpressions ?? []).flatMap((expression) =>
    expression.tempoChange
      ? [
          {
            start: expression.measure,
            end:
              expression.tempoChange.type === 'aTempo'
                ? expression.measure
                : (expression.tempoChange.endMeasure ?? expression.measure),
          },
        ]
      : [],
  );
  const rampStarts = [
    ...map.sections
      .filter(
        (section) =>
          section.startMeasure < measure &&
          (section.tempoChange?.type === 'rit' || section.tempoChange?.type === 'accel') &&
          !measureTempoSpans.some(
            (span) => span.start <= section.startMeasure && span.end >= section.startMeasure,
          ),
      )
      .map((section) => section.startMeasure),
    ...(map.measureExpressions ?? [])
      .filter(
        (expression) =>
          expression.measure < measure &&
          (expression.tempoChange?.type === 'rit' || expression.tempoChange?.type === 'accel'),
      )
      .map((expression) => expression.measure),
  ];
  return tempoAtMeasureStart(
    map,
    rampStarts.length
      ? rampStarts.reduce((latest, start) => Math.max(latest, start))
      : Math.max(1, measure - 1),
  );
}

/** Suggestions use the real timeline only for a valid map; invalid drafts keep editable values. */
function suggestedMeasureTempo(map: TempoMap, index: number, restore: boolean): number | undefined {
  const expression = map.measureExpressions?.[index];
  if (!expression) return undefined;
  const section = map.sections.find(
    (current) =>
      current.startMeasure <= expression.measure && current.endMeasure >= expression.measure,
  );
  if (!section) return undefined;
  const inherited = updateMeasureExpression(map, index, withoutMeasureTempo(expression));
  if (!validateTempoMap(inherited).valid) {
    return expression.tempoChange?.targetBpm ?? sectionBpm(section);
  }
  return restore
    ? restoredTempoAtMeasure(inherited, expression.measure)
    : tempoAtMeasureStart(inherited, expression.measure);
}

function primaryBeatsAtMeasure(map: TempoMap, measure: number): number[] {
  const section = map.sections.find(
    (current) => current.startMeasure <= measure && current.endMeasure >= measure,
  );
  if (!section) return [];
  const count = beatsPerMeasure(section);
  if (!Number.isInteger(count) || count < 1 || count > 64) return [];
  const first = measure === 1 && map.anacrusis ? count - map.anacrusis.beats + 1 : 1;
  if (!Number.isInteger(first) || first < 1 || first > count) return [];
  return Array.from({ length: count - first + 1 }, (_, index) => first + index);
}

function accentsFor(section: TempoSection, previous: Accent[] = []): Accent[] {
  const count = beatsPerMeasure(section);
  if (!Number.isInteger(count) || count < 1 || count > 64) return previous;
  return Array.from({ length: count }, (_, index) => previous[index] ?? (index === 0 ? 2 : 1));
}

function updateSection(map: TempoMap, id: string, patch: Partial<TempoSection>): TempoMap {
  return {
    ...map,
    sections: map.sections
      .map((section) => (section.id === id ? { ...section, ...patch } : section))
      .sort((left, right) => left.startMeasure - right.startMeasure),
  };
}

function removeSectionExpression(
  map: TempoMap,
  id: string,
  key: 'tempoChange' | 'fermata' | 'breath',
): TempoMap {
  return {
    ...map,
    sections: map.sections.map((section) => {
      if (section.id !== id) return section;
      const next = { ...section };
      delete next[key];
      return next;
    }),
  };
}

function updateSectionMeter(
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
function resizeTempoMap(map: TempoMap, totalMeasures: number): TempoMap {
  if (!Number.isInteger(totalMeasures) || totalMeasures < 1) return { ...map, totalMeasures };
  const sections = map.sections
    .filter((section) => section.startMeasure <= totalMeasures)
    .map((section) => ({ ...section, endMeasure: Math.min(section.endMeasure, totalMeasures) }));
  const last = sections.at(-1);
  if (last) last.endMeasure = totalMeasures;
  return { ...map, totalMeasures, sections };
}

/** Move a section's musical contents and duration, then recompute every contiguous boundary. */
function moveTempoSection(map: TempoMap, id: string, direction: -1 | 1): TempoMap {
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

function splitTempoSection(
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
  const opening = cloneSection(selected);
  delete opening.fermata;
  delete opening.breath;
  return {
    ...map,
    sections: map.sections
      .map((section) =>
        section.id === selected.id ? { ...opening, endMeasure: splitMeasure - 1 } : section,
      )
      .concat(next)
      .sort((left, right) => left.startMeasure - right.startMeasure),
  };
}

function mergeTempoSectionWithPrevious(map: TempoMap, id: string): TempoMap {
  const index = map.sections.findIndex((section) => section.id === id);
  const selected = map.sections[index];
  const previous = map.sections[index - 1];
  if (!selected || !previous) return map;
  if (previous.fermata || previous.breath) return map;
  return {
    ...map,
    sections: map.sections
      .filter((section) => section.id !== selected.id)
      .map((section) =>
        section.id === previous.id
          ? {
              ...section,
              endMeasure: selected.endMeasure,
              ...(selected.fermata ? { fermata: { ...selected.fermata } } : {}),
              ...(selected.breath ? { breath: { ...selected.breath } } : {}),
            }
          : section,
      ),
  };
}

function deleteTempoSection(map: TempoMap, id: string): { map: TempoMap; selectedId: string } {
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
function calculateTapTempo(timestampsMs: readonly number[]): number | null {
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

function tempoMapFromServer(response: ServerTempoMap, repertoireItemId: string): TempoMap {
  const candidate: unknown = {
    ...response.data,
    id: response.data.id || response.id,
    repertoireItemId,
    revision: response.revision,
  };
  assertValidTempoMap(candidate);
  return candidate;
}

function isNetworkFailure(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

function createJump(type: JumpType, map: TempoMap, section: TempoSection): JumpDirective {
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

function updateJump(map: TempoMap, index: number, jump: JumpDirective): TempoMap {
  return {
    ...map,
    jumps: map.jumps.map((current, currentIndex) => (currentIndex === index ? jump : current)),
  };
}

function friendlyIssue(issue: TempoMapValidationIssue): string {
  if (issue.path.endsWith('.fermata.extraBeats')) return '0보다 크고 16 이하인 박 수를 입력하세요.';
  if (issue.path.endsWith('.breath.durationSec')) return '0보다 크고 300 이하인 초를 입력하세요.';
  if (issue.path.endsWith('.fermata.beat')) return '해당 마디에서 실제 연주하는 박을 선택하세요.';
  if (issue.path.startsWith('measureExpressions[') && issue.path.endsWith('.measure')) {
    return issue.code === 'duplicate'
      ? '한 마디에는 표현 설정을 하나만 둘 수 있습니다.'
      : '곡 전체 범위 안의 마디 번호를 입력하세요.';
  }
  if (issue.path.startsWith('measureExpressions[') && issue.code === 'ambiguous') {
    return '템포 변화 범위가 겹칩니다. 앞선 변화의 끝 마디를 조정하세요.';
  }
  if (issue.path.startsWith('measureExpressions[') && issue.path.endsWith('.endMeasure')) {
    return '표현 마디부터 곡 마지막 마디 사이의 번호를 입력하세요.';
  }
  const fallbacks: Record<TempoMapValidationIssue['code'], string> = {
    required: '필수 값을 입력하세요.',
    range: '곡과 반복 범위 안의 값을 입력하세요.',
    integer: '허용된 정수를 입력하세요.',
    order: '시작보다 끝이 빠를 수 없습니다.',
    coverage: '모든 마디를 빈틈이나 겹침 없이 한 번씩 포함해야 합니다.',
    duplicate: '중복 값을 제거하세요.',
    meter: '박자표와 박 단위가 한 마디를 정확히 나누도록 수정하세요.',
    tempo:
      'BPM과 템포 변화 목표를 확인하세요. 리타르단도는 느리게, 아첼레란도는 빠르게 설정합니다.',
    accent: '강세 수를 해당 박자의 박 수와 맞추고 0–2만 사용하세요.',
    jump: '이동 마디와 Fine/Coda 연결을 곡 범위 안에서 완성하세요.',
    ambiguous: '서로 겹치거나 중복되는 진행 지시를 정리하세요.',
  };
  return fallbacks[issue.code];
}

function issueFor(
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

type EditorFieldProps = Omit<ComponentProps<typeof Field>, 'error'> & {
  error?: string | undefined;
};

function EditorField({ error, ...props }: EditorFieldProps) {
  return <Field {...props} {...(error ? { error } : {})} />;
}

function SelectField({
  label,
  value,
  onChange,
  error,
  children,
  ariaLabel,
  disabled,
}: {
  label: string;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  error?: string | undefined;
  children: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const id = `editor-select-${generatedId.replaceAll(':', '')}`;
  const descriptionId = error ? `${id}-error` : undefined;
  return (
    <label className="fmr-field" htmlFor={id}>
      <span className="fmr-field__label">{label}</span>
      <select
        id={id}
        className={error ? 'fmr-input fmr-input--error' : 'fmr-input'}
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      >
        {children}
      </select>
      {error ? (
        <span id={descriptionId} className="fmr-field__hint fmr-field__error">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="editor-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

function MeasureExpressionFields({
  map,
  expression,
  index,
  issues,
  onChange,
  onDelete,
}: {
  map: TempoMap;
  expression: MeasureExpression;
  index: number;
  issues: readonly TempoMapValidationIssue[];
  onChange: (expression: MeasureExpression) => void;
  onDelete: () => void;
}) {
  const path = `measureExpressions[${index}]`;
  const primaryBeats = primaryBeatsAtMeasure(map, expression.measure);
  const hasLegacyEnd = map.sections.some(
    (section) => section.endMeasure === expression.measure && (section.fermata || section.breath),
  );
  return (
    <fieldset className="jump-editor" aria-label={`${expression.measure}마디 연주 표현`}>
      <legend>{expression.measure}마디</legend>
      <div className="jump-editor__header">
        <EditorField
          label="표현 마디"
          aria-label="표현 마디"
          type="number"
          min={1}
          max={map.totalMeasures}
          value={expression.measure}
          error={issueFor(issues, `${path}.measure`)}
          onChange={(event) => onChange({ ...expression, measure: Number(event.target.value) })}
        />
        <Button
          variant="ghost"
          onClick={onDelete}
          aria-label={`${expression.measure}마디 표현 삭제`}
        >
          <Trash2 size={16} aria-hidden /> 표현 삭제
        </Button>
      </div>
      <div className="property-grid">
        <SelectField
          label="템포 변화"
          ariaLabel="템포 변화"
          value={expression.tempoChange?.type ?? 'none'}
          disabled={primaryBeats.length === 0}
          error={issueFor(issues, `${path}.tempoChange`, true)}
          onChange={(event) => {
            const type = event.target.value;
            if (type === 'none') {
              onChange(withoutMeasureTempo(expression));
              return;
            }
            const base = suggestedMeasureTempo(map, index, type === 'aTempo');
            if (base === undefined) return;
            onChange({
              ...expression,
              tempoChange:
                type === 'aTempo'
                  ? { type, targetBpm: base }
                  : {
                      type: type as 'rit' | 'accel',
                      targetBpm: type === 'rit' ? Math.max(base / 2, base - 10) : base + 10,
                      endMeasure: expression.measure,
                    },
            });
          }}
        >
          <option value="none">없음 · 앞의 빠르기 이어받기</option>
          <option value="rit">리타르단도 · rit. (점점 느리게)</option>
          <option value="accel">아첼레란도 · accel. (점점 빠르게)</option>
          <option value="aTempo">아 템포 · a tempo (원래 빠르기로)</option>
        </SelectField>
        {expression.tempoChange ? (
          <>
            <EditorField
              label={expression.tempoChange.type === 'aTempo' ? '복귀 BPM' : '도착 BPM'}
              aria-label={expression.tempoChange.type === 'aTempo' ? '복귀 BPM' : '도착 BPM'}
              type="number"
              min={0}
              step="any"
              value={expression.tempoChange.targetBpm}
              hint={
                expression.tempoChange.type === 'aTempo'
                  ? '이 마디 첫 박부터 적용합니다. 복귀할 빠르기를 직접 바꿀 수 있습니다.'
                  : '지정한 마지막 마디까지 점차 바뀐 뒤 다음 템포 지시나 새 구간까지 유지합니다.'
              }
              error={
                issueFor(issues, `${path}.tempoChange.targetBpm`) ??
                issueFor(issues, `${path}.tempoChange`)
              }
              onChange={(event) =>
                onChange({
                  ...expression,
                  tempoChange: {
                    ...expression.tempoChange!,
                    targetBpm: Number(event.target.value),
                  },
                })
              }
            />
            {expression.tempoChange.type !== 'aTempo' ? (
              <EditorField
                label="변화 끝 마디"
                aria-label="변화 끝 마디"
                type="number"
                min={expression.measure}
                max={map.totalMeasures}
                value={expression.tempoChange.endMeasure ?? expression.measure}
                hint="시작 마디와 같으면 그 한 마디에서 변화합니다."
                error={issueFor(issues, `${path}.tempoChange.endMeasure`)}
                onChange={(event) =>
                  onChange({
                    ...expression,
                    tempoChange: {
                      ...expression.tempoChange!,
                      endMeasure: Number(event.target.value),
                    },
                  })
                }
              />
            ) : null}
          </>
        ) : null}
        <CheckboxField
          label="페르마타"
          hint="이 마디의 선택한 박을 더 늘입니다."
          checked={Boolean(expression.fermata)}
          onChange={(checked) => {
            const next = { ...expression };
            if (checked) next.fermata = { extraBeats: 1 };
            else delete next.fermata;
            onChange(next);
          }}
        />
        {expression.fermata ? (
          <>
            <SelectField
              label="늘일 박"
              ariaLabel="늘일 박"
              value={expression.fermata.beat ?? 'last'}
              error={issueFor(issues, `${path}.fermata.beat`)}
              onChange={(event) => {
                const fermata = { ...expression.fermata! };
                if (event.target.value === 'last') delete fermata.beat;
                else fermata.beat = Number(event.target.value);
                onChange({ ...expression, fermata });
              }}
            >
              <option value="last">
                마지막 박{primaryBeats.at(-1) ? ` · ${primaryBeats.at(-1)}박` : ''}
              </option>
              {primaryBeats.map((beat) => (
                <option key={beat} value={beat}>
                  {beat}박
                </option>
              ))}
              {expression.fermata.beat !== undefined &&
              !primaryBeats.includes(expression.fermata.beat) ? (
                <option value={expression.fermata.beat}>
                  {expression.fermata.beat}박 · 범위 확인
                </option>
              ) : null}
            </SelectField>
            <EditorField
              label="추가로 늘일 박 수"
              aria-label="추가로 늘일 박 수"
              type="number"
              min={0}
              max={16}
              step="any"
              value={expression.fermata.extraBeats}
              hint="0보다 크고 16 이하 · 예: 0.5박, 1박"
              error={issueFor(issues, `${path}.fermata.extraBeats`)}
              onChange={(event) =>
                onChange({
                  ...expression,
                  fermata: { ...expression.fermata!, extraBeats: Number(event.target.value) },
                })
              }
            />
          </>
        ) : null}
        <CheckboxField
          label="쉼표 · 숨 고르기"
          hint="이 마디가 끝나면 잠시 쉰 뒤 자동으로 다시 시작합니다."
          checked={Boolean(expression.breath)}
          onChange={(checked) => {
            const next = { ...expression };
            if (checked) next.breath = { durationSec: 2, countIn: true };
            else delete next.breath;
            onChange(next);
          }}
        />
        {expression.breath ? (
          <>
            <EditorField
              label="쉬는 시간 (초)"
              aria-label="쉬는 시간 (초)"
              type="number"
              min={0}
              max={300}
              step="any"
              value={expression.breath.durationSec}
              hint="0보다 크고 300 이하 · 예비박 시간은 별도입니다."
              error={issueFor(issues, `${path}.breath.durationSec`)}
              onChange={(event) =>
                onChange({
                  ...expression,
                  breath: { ...expression.breath!, durationSec: Number(event.target.value) },
                })
              }
            />
            <CheckboxField
              label="재개 전 예비박"
              hint={`쉰 뒤 다음 마디의 박자·빠르기로 ${map.countIn.measures}마디를 듣습니다. 연주가 끝나면 생략합니다.`}
              checked={expression.breath.countIn}
              onChange={(checked) =>
                onChange({
                  ...expression,
                  breath: { ...expression.breath!, countIn: checked },
                })
              }
            />
          </>
        ) : null}
      </div>
      {hasLegacyEnd ? (
        <p className="subtle">
          이 마디의 페르마타·쉼표는 아래 구간 끝 기본 표현보다 우선합니다. 여기서 끄면 구간 기본값도
          적용하지 않습니다.
        </p>
      ) : null}
    </fieldset>
  );
}

function JumpFields({
  jump,
  index,
  map,
  issues,
  onChange,
}: {
  jump: JumpDirective;
  index: number;
  map: TempoMap;
  issues: readonly TempoMapValidationIssue[];
  onChange: (jump: JumpDirective) => void;
}) {
  const path = `jumps[${index}]`;
  if (jump.type === 'repeat') {
    const endings = jump.endings ?? [];
    const updateEnding = (endingIndex: number, next: VoltaEnding) => {
      const nextEndings = endings.map((ending, current) =>
        current === endingIndex ? next : ending,
      );
      onChange({ ...jump, endings: nextEndings });
    };
    const addEnding = () => {
      const usedPasses = new Set(endings.flatMap((ending) => ending.forPass));
      const pass = Array.from({ length: jump.times }, (_, item) => item + 1).find(
        (item) => !usedPasses.has(item),
      );
      const offset = Math.min(endings.length, jump.endMeasure - jump.startMeasure);
      onChange({
        ...jump,
        endings: [
          ...endings,
          {
            measures: [jump.endMeasure - offset, jump.endMeasure - offset],
            forPass: [pass ?? 1],
          },
        ],
      });
    };
    return (
      <>
        <div className="jump-field-grid">
          <EditorField
            label="반복 시작 마디"
            type="number"
            min={1}
            max={map.totalMeasures}
            value={jump.startMeasure}
            error={issueFor(issues, `${path}.startMeasure`)}
            onChange={(event) => onChange({ ...jump, startMeasure: Number(event.target.value) })}
          />
          <EditorField
            label="반복 끝 마디"
            type="number"
            min={jump.startMeasure}
            max={map.totalMeasures}
            value={jump.endMeasure}
            error={issueFor(issues, `${path}.endMeasure`)}
            onChange={(event) => onChange({ ...jump, endMeasure: Number(event.target.value) })}
          />
          <EditorField
            label="총 연주 횟수"
            type="number"
            min={1}
            max={8}
            value={jump.times}
            error={issueFor(issues, `${path}.times`)}
            onChange={(event) => {
              const times = Number(event.target.value);
              onChange({
                ...jump,
                times,
                ...(jump.endings
                  ? {
                      endings: jump.endings.map((ending) => ({
                        ...ending,
                        forPass: ending.forPass.filter((pass) => pass <= times),
                      })),
                    }
                  : {}),
              });
            }}
          />
        </div>
        <div className="volta-editor">
          <div className="volta-editor__header">
            <div>
              <strong>1st / 2nd ending</strong>
              <p>엔딩 마디와 이 엔딩을 연주할 패스를 선택합니다.</p>
            </div>
            <Button onClick={addEnding}>
              <Plus size={16} aria-hidden /> 볼타 엔딩 추가
            </Button>
          </div>
          {endings.length === 0 ? (
            <p className="subtle">볼타 엔딩이 없습니다.</p>
          ) : (
            endings.map((ending, endingIndex) => {
              const endingPath = `${path}.endings[${endingIndex}]`;
              return (
                <fieldset className="volta-ending" key={endingIndex}>
                  <legend>{endingIndex + 1}번 엔딩</legend>
                  <div className="jump-field-grid">
                    <EditorField
                      label="엔딩 시작 마디"
                      type="number"
                      min={jump.startMeasure}
                      max={jump.endMeasure}
                      value={ending.measures[0]}
                      error={issueFor(issues, `${endingPath}.measures`)}
                      onChange={(event) =>
                        updateEnding(endingIndex, {
                          ...ending,
                          measures: [Number(event.target.value), ending.measures[1]],
                        })
                      }
                    />
                    <EditorField
                      label="엔딩 끝 마디"
                      type="number"
                      min={ending.measures[0]}
                      max={jump.endMeasure}
                      value={ending.measures[1]}
                      error={issueFor(issues, `${endingPath}.measures`)}
                      onChange={(event) =>
                        updateEnding(endingIndex, {
                          ...ending,
                          measures: [ending.measures[0], Number(event.target.value)],
                        })
                      }
                    />
                  </div>
                  <div
                    className="pass-picker"
                    role="group"
                    aria-label={`${endingIndex + 1}번 엔딩 패스`}
                  >
                    {Array.from({ length: Math.max(0, jump.times) }, (_, passIndex) => {
                      const pass = passIndex + 1;
                      return (
                        <label key={pass}>
                          <input
                            type="checkbox"
                            checked={ending.forPass.includes(pass)}
                            onChange={(event) =>
                              updateEnding(endingIndex, {
                                ...ending,
                                forPass: event.target.checked
                                  ? [...ending.forPass, pass].sort((left, right) => left - right)
                                  : ending.forPass.filter((item) => item !== pass),
                              })
                            }
                          />
                          {pass}번째 패스
                        </label>
                      );
                    })}
                  </div>
                  {issueFor(issues, `${endingPath}.forPass`, true) ? (
                    <p className="inline-issue">
                      {issueFor(issues, `${endingPath}.forPass`, true)}
                    </p>
                  ) : null}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        ...jump,
                        endings: endings.filter((_, current) => current !== endingIndex),
                      })
                    }
                  >
                    <Trash2 size={16} aria-hidden /> 엔딩 삭제
                  </Button>
                </fieldset>
              );
            })
          )}
          {issueFor(issues, `${path}.endings`, true) ? (
            <p className="inline-issue">{issueFor(issues, `${path}.endings`, true)}</p>
          ) : null}
        </div>
      </>
    );
  }

  if (jump.type === 'dc' || jump.type === 'ds') {
    return (
      <>
        <div className="jump-field-grid">
          <EditorField
            label={`${JUMP_LABELS[jump.type]} 실행 마디`}
            type="number"
            min={1}
            max={map.totalMeasures}
            value={jump.atMeasure}
            error={issueFor(issues, `${path}.atMeasure`)}
            onChange={(event) => onChange({ ...jump, atMeasure: Number(event.target.value) })}
          />
          {jump.type === 'ds' ? (
            <EditorField
              label="Segno 마디"
              type="number"
              min={1}
              max={map.totalMeasures}
              value={jump.segnoMeasure}
              error={issueFor(issues, `${path}.segnoMeasure`)}
              onChange={(event) => onChange({ ...jump, segnoMeasure: Number(event.target.value) })}
            />
          ) : null}
          {jump.alFine !== undefined ? (
            <EditorField
              label="Fine 마디"
              type="number"
              min={1}
              max={map.totalMeasures}
              value={jump.alFine}
              error={issueFor(issues, `${path}.alFine`)}
              onChange={(event) => onChange({ ...jump, alFine: Number(event.target.value) })}
            />
          ) : null}
        </div>
        <div className="jump-options">
          <CheckboxField
            label="al Fine"
            checked={jump.alFine !== undefined}
            hint="되돌아간 뒤 Fine 마디에서 끝냅니다."
            onChange={(checked) => {
              if (checked) {
                onChange({ ...jump, alFine: jump.alFine ?? map.totalMeasures });
                return;
              }
              const { alFine: _removed, ...withoutFine } = jump;
              void _removed;
              onChange(withoutFine);
            }}
          />
          <CheckboxField
            label="al Coda"
            checked={jump.alCoda === true}
            hint="별도의 To Coda·Coda 지시가 필요합니다."
            onChange={(checked) => {
              if (checked) {
                onChange({ ...jump, alCoda: true });
                return;
              }
              const { alCoda: _removed, ...withoutCoda } = jump;
              void _removed;
              onChange(withoutCoda);
            }}
          />
        </div>
      </>
    );
  }

  return (
    <div className="jump-field-grid">
      <EditorField
        label="To Coda 마디"
        type="number"
        min={1}
        max={map.totalMeasures}
        value={jump.toCodaMeasure}
        error={issueFor(issues, `${path}.toCodaMeasure`) ?? issueFor(issues, path)}
        onChange={(event) => onChange({ ...jump, toCodaMeasure: Number(event.target.value) })}
      />
      <EditorField
        label="Coda 시작 마디"
        type="number"
        min={1}
        max={map.totalMeasures}
        value={jump.codaMeasure}
        error={issueFor(issues, `${path}.codaMeasure`) ?? issueFor(issues, path)}
        onChange={(event) => onChange({ ...jump, codaMeasure: Number(event.target.value) })}
      />
    </div>
  );
}

export function EditorPage() {
  const { tempoMapId } = useParams();
  const { user, client } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const localSource = searchParams.get('source') === 'local';
  const scoreId = searchParams.get('score');
  const { notify } = useToast();
  const [map, setMap] = useState<TempoMap>(() => createDefaultTempoMap());
  const [selectedId, setSelectedId] = useState(map.sections[0]?.id ?? '');
  const [zoom, setZoom] = useState(1);
  const [tableMode, setTableMode] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitMeasure, setSplitMeasure] = useState(2);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [cacheNotice, setCacheNotice] = useState<string>();
  const [offlineReadOnlyFor, setOfflineReadOnlyFor] = useState<{
    tempoMapId: string;
    userId: string;
  }>();
  const [reloadKey, setReloadKey] = useState(0);
  const [serverSnapshot, setServerSnapshot] = useState<TempoMap>();
  const [remoteRole, setRemoteRole] = useState<'owner' | 'leader' | 'member'>();
  const [loadConflict, setLoadConflict] = useState<LoadConflict>();
  const [saveConflict, setSaveConflict] = useState<SaveConflict>();
  const [rebasedPending, setRebasedPending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [undoDelete, setUndoDelete] = useState<UndoDelete>();
  const [newJumpType, setNewJumpType] = useState<JumpType>('repeat');
  const [newExpressionMeasure, setNewExpressionMeasure] = useState(1);
  const [tapStatus, setTapStatus] = useState('두 번 이상 일정하게 두드리세요.');
  const tapTimesRef = useRef<number[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const remoteCacheScope = useMemo(
    () => (user && !localSource ? { userId: user.id } : undefined),
    [localSource, user],
  );
  const isOfflineReadOnly =
    offlineReadOnlyFor !== undefined &&
    offlineReadOnlyFor.tempoMapId === tempoMapId &&
    offlineReadOnlyFor.userId === user?.id;
  const isReadOnly = isOfflineReadOnly || remoteRole === 'member';

  const editMap = useCallback(
    (next: SetStateAction<TempoMap>) => {
      if (!isReadOnly) setMap(next);
    },
    [isReadOnly],
  );

  const cacheMap = useCallback(
    async (next: TempoMap) => {
      try {
        await localDb.putTempoMap(next, remoteCacheScope);
        return true;
      } catch (error) {
        notify({
          title: '로컬 캐시를 동기화하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'info',
        });
        return false;
      }
    },
    [notify, remoteCacheScope],
  );

  const fetchServerMap = useCallback(
    async (repertoireItemId: string): Promise<TempoMap> => {
      const response = await client.get<ServerTempoMap>(`/repertoire/${repertoireItemId}/tempomap`);
      return tempoMapFromServer(response, repertoireItemId);
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoadState('loading');
      setLoadError('');
      setCacheNotice(undefined);
      setOfflineReadOnlyFor(undefined);
      setLoadConflict(undefined);
      setSaveConflict(undefined);
      setRebasedPending(false);
      setServerSnapshot(undefined);
      setRemoteRole(undefined);
      setSplitOpen(false);
      setUndoDelete(undefined);
      setNewExpressionMeasure(1);

      const readCachedMap = async (): Promise<{ map?: TempoMap; error?: unknown }> => {
        const results = await Promise.allSettled([
          localDb.getTempoMapForRepertoire(tempoMapId ?? '', remoteCacheScope),
          localDb.getTempoMap(tempoMapId ?? '', remoteCacheScope),
        ]);
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        const error: unknown = rejected?.reason;
        const stored = results.find(
          (result): result is PromiseFulfilledResult<TempoMap | undefined> =>
            result.status === 'fulfilled' && result.value !== undefined,
        )?.value;
        if (!stored) return error ? { error } : {};
        try {
          return { map: tempoMapContract(stored), ...(error === undefined ? {} : { error }) };
        } catch (validationError) {
          return { error: validationError };
        }
      };

      const setCacheFailureNotice = () => {
        setCacheNotice(
          '로컬 사본을 읽거나 갱신하지 못했습니다. 서버 데이터는 정상적으로 사용 중입니다.',
        );
      };

      try {
        if (!tempoMapId) {
          const next = createDefaultTempoMap();
          if (cancelled) return;
          setMap(next);
          setSelectedId(next.sections[0]?.id ?? '');
          setServerSnapshot(undefined);
          setSavedFingerprint('');
          setLoadState('ready');
          return;
        }

        if (!user || localSource) {
          const { map: local, error } = await readCachedMap();
          if (cancelled) return;
          if (error) {
            throw error instanceof Error ? error : new Error('로컬 템포맵을 읽지 못했습니다.');
          }
          if (local) {
            setMap(local);
            setSelectedId(local.sections[0]?.id ?? '');
            setSavedFingerprint(fingerprint(local));
            setLoadState('ready');
            return;
          }
          const next = { ...createDefaultTempoMap(), id: tempoMapId };
          setMap(next);
          setSelectedId(next.sections[0]?.id ?? '');
          setSavedFingerprint('');
          setLoadState('ready');
          return;
        }

        // Start the best-effort cache read without allowing IndexedDB to delay or
        // override the authoritative server response. It is only consumed below
        // when fetch itself fails at the network boundary.
        const cachedMap = readCachedMap();
        void cachedMap.then(({ error }) => {
          if (!cancelled && error) setCacheFailureNotice();
        });

        try {
          const access = await client.get<components['schemas']['RepertoireAccessOut']>(
            `/repertoire/${encodeURIComponent(tempoMapId)}/access`,
          );
          if (cancelled) return;
          setRemoteRole(access.role);
          let server: TempoMap;
          try {
            server = await fetchServerMap(tempoMapId);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
            const revisions = await client
              .get<ServerTempoMap[]>(
                `/repertoire/${encodeURIComponent(tempoMapId)}/tempomap/revisions`,
              )
              .catch((verificationError: unknown) => {
                if (!isNetworkFailure(verificationError)) throw verificationError;
                throw new Error(
                  '첫 템포맵을 만들 수 있는지 확인하지 못했습니다. 다시 시도해 주세요.',
                  {
                    cause: verificationError,
                  },
                );
              });
            if (revisions.length !== 0) throw error;
            if (access.role === 'member') {
              throw new Error(
                '아직 템포맵이 없습니다. 프로젝트 리더에게 첫 템포맵 작성을 요청하세요.',
                { cause: error },
              );
            }
            server = createDefaultTempoMap(tempoMapId, 0);
          }
          if (cancelled) return;
          setMap(server);
          setSelectedId(server.sections[0]?.id ?? '');
          setServerSnapshot(server);
          setSavedFingerprint(server.revision === 0 ? '' : fingerprint(server));
          setLoadState('ready');
          if (server.revision > 0) {
            void cacheMap(server).then((cached) => {
              if (!cancelled && !cached) setCacheFailureNotice();
            });
          }
        } catch (serverError) {
          if (!isNetworkFailure(serverError)) throw serverError;
          const { map: cached, error } = await cachedMap;
          if (cancelled) return;
          if (!cached) {
            throw new Error(
              error
                ? '네트워크에 연결할 수 없고 로컬 사본도 읽지 못했습니다.'
                : '네트워크에 연결할 수 없고 저장된 템포맵도 없습니다.',
              { cause: serverError },
            );
          }
          setMap(cached);
          setSelectedId(cached.sections[0]?.id ?? '');
          setSavedFingerprint(fingerprint(cached));
          setOfflineReadOnlyFor({ tempoMapId, userId: user.id });
          if (error) setCacheFailureNotice();
          setLoadState('ready');
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadState('error');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    cacheMap,
    client,
    fetchServerMap,
    localSource,
    reloadKey,
    remoteCacheScope,
    tempoMapId,
    user,
  ]);

  const selectedIndex = map.sections.findIndex((section) => section.id === selectedId);
  const selected = map.sections[selectedIndex] ?? map.sections[0];
  const previousSection = map.sections[selectedIndex - 1];
  const mergeBlockedByExpression = Boolean(previousSection?.fermata || previousSection?.breath);
  const expressionMeasureError =
    !Number.isInteger(newExpressionMeasure) ||
    newExpressionMeasure < 1 ||
    newExpressionMeasure > map.totalMeasures
      ? `1부터 ${map.totalMeasures} 사이의 마디 번호를 입력하세요.`
      : map.measureExpressions?.some((expression) => expression.measure === newExpressionMeasure)
        ? '이미 표현이 있는 마디입니다. 아래 설정을 편집하세요.'
        : undefined;
  const validation = useMemo(() => validateTempoMap(map), [map]);
  const preview = useMemo(() => {
    if (!validation.valid) {
      return {
        timeline: null,
        error: `검증 오류 ${validation.issues.length}개를 먼저 해결하세요.`,
      };
    }
    try {
      return { timeline: expandTimeline(map), error: null };
    } catch (error) {
      return {
        timeline: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [map, validation]);
  const isRemote = Boolean(user && !localSource && map.repertoireItemId !== 'local');
  const playbackPath = isRemote
    ? `/?repertoire=${encodeURIComponent(map.repertoireItemId)}`
    : `/?tempoMap=${encodeURIComponent(map.id)}`;
  const scorePath = isRemote
    ? `/repertoire/${encodeURIComponent(map.repertoireItemId)}/scores${scoreId ? `/${encodeURIComponent(scoreId)}` : ''}`
    : scoreId
      ? `/scores/${encodeURIComponent(scoreId)}`
      : undefined;
  const isDirty = fingerprint(map) !== savedFingerprint;
  const shouldWarnAboutUnsavedChanges = loadState === 'ready' && isDirty;
  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      shouldWarnAboutUnsavedChanges &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
    [shouldWarnAboutUnsavedChanges],
  );
  const blocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!shouldWarnAboutUnsavedChanges) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [shouldWarnAboutUnsavedChanges],
    ),
    { capture: true },
  );

  useEffect(() => {
    if (
      blocker.state === 'blocked' &&
      !shouldWarnAboutUnsavedChanges &&
      !isSaving &&
      !saveConflict
    ) {
      blocker.proceed();
    }
  }, [blocker, isSaving, saveConflict, shouldWarnAboutUnsavedChanges]);

  const applyServerMap = useCallback(
    async (next: TempoMap) => {
      setMap(next);
      setSelectedId((current) =>
        next.sections.some((section) => section.id === current)
          ? current
          : (next.sections[0]?.id ?? ''),
      );
      setServerSnapshot(next);
      setSavedFingerprint(fingerprint(next));
      setRebasedPending(false);
      setUndoDelete(undefined);
      await cacheMap(next);
    },
    [cacheMap],
  );

  const save = async (): Promise<boolean> => {
    if (isReadOnly) {
      notify({
        title: isOfflineReadOnly
          ? '오프라인 읽기 전용 상태에서는 저장할 수 없습니다.'
          : '프로젝트 리더만 템포맵을 저장할 수 있습니다.',
        tone: 'info',
      });
      return false;
    }
    if (!validation.valid || preview.error) {
      notify({
        title: '템포맵 오류를 먼저 고쳐 주세요.',
        description: preview.error ?? '필드 아래의 해결 방법을 확인하세요.',
        tone: 'danger',
      });
      return false;
    }
    setIsSaving(true);
    const draft = map;
    try {
      if (isRemote) {
        const prepared =
          serverSnapshot && draft.revision !== serverSnapshot.revision
            ? rebaseTempoMapDraft(draft, serverSnapshot)
            : draft;
        const response = await client.put<ServerTempoMap>(
          `/repertoire/${prepared.repertoireItemId}/tempomap`,
          { expectedRevision: prepared.revision, data: prepared },
        );
        const saved = tempoMapFromServer(response, prepared.repertoireItemId);
        await applyServerMap(saved);
      } else {
        const saved = { ...draft, revision: draft.revision + 1 };
        await localDb.putTempoMap(saved);
        localStorage.setItem('fmr.activeTempoMap', saved.id);
        setMap(saved);
        setSavedFingerprint(fingerprint(saved));
        setUndoDelete(undefined);
      }
      notify({ title: '템포맵을 저장했습니다.', tone: 'success' });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && isRemote) {
        try {
          const latest = await fetchServerMap(draft.repertoireItemId);
          if (!latest) {
            throw new Error('서버 최신 revision을 찾지 못했습니다.', { cause: error });
          }
          const rebased = rebaseTempoMapDraft(draft, latest);
          await cacheMap(rebased);
          setServerSnapshot(latest);
          setSaveConflict({ draft, latest, rebased });
        } catch (refreshError) {
          notify({
            title: '충돌 후 서버 최신본을 불러오지 못했습니다.',
            description:
              refreshError instanceof Error ? refreshError.message : String(refreshError),
            tone: 'danger',
          });
        }
      } else {
        notify({
          title: '저장하지 못했습니다.',
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        });
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const saveAndContinueNavigation = async () => {
    if (blocker.state !== 'blocked') return;
    await save();
  };

  const addMeasureExpression = () => {
    if (expressionMeasureError) return;
    const legacy = map.sections.find((section) => section.endMeasure === newExpressionMeasure);
    const expression: MeasureExpression = {
      measure: newExpressionMeasure,
      ...(legacy?.fermata ? { fermata: { ...legacy.fermata } } : {}),
      ...(legacy?.breath ? { breath: { ...legacy.breath } } : {}),
    };
    editMap((current) => ({
      ...current,
      measureExpressions: [...(current.measureExpressions ?? []), expression].sort(
        (left, right) => left.measure - right.measure,
      ),
    }));
    const occupied = new Set([
      ...(map.measureExpressions ?? []).map((current) => current.measure),
      newExpressionMeasure,
    ]);
    let nextMeasure = 1;
    while (occupied.has(nextMeasure) && nextMeasure < map.totalMeasures) nextMeasure += 1;
    setNewExpressionMeasure(nextMeasure);
  };

  const split = () => {
    if (!selected) return;
    try {
      const nextId = crypto.randomUUID();
      editMap((current) => splitTempoSection(current, selected.id, splitMeasure, nextId));
      setSelectedId(nextId);
      setSplitOpen(false);
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    }
  };

  const mergePrevious = () => {
    if (!selected || mergeBlockedByExpression) return;
    const previous = map.sections[selectedIndex - 1];
    if (!previous) return;
    editMap((current) => mergeTempoSectionWithPrevious(current, selected.id));
    setSelectedId(previous.id);
  };

  const removeSection = () => {
    if (!selected || map.sections.length === 1) return;
    setUndoDelete({
      map,
      selectedId: selected.id,
      label: selected.label ?? `${selected.startMeasure}–${selected.endMeasure}마디`,
    });
    const result = deleteTempoSection(map, selected.id);
    editMap(result.map);
    setSelectedId(result.selectedId);
  };

  const tapTempo = () => {
    const now = performance.now();
    const previous = tapTimesRef.current.at(-1);
    tapTimesRef.current =
      previous !== undefined && now - previous <= 2_000
        ? [...tapTimesRef.current.slice(-7), now]
        : [now];
    const bpm = calculateTapTempo(tapTimesRef.current);
    if (!bpm || !selected) {
      setTapStatus('한 번 더 두드리세요.');
      return;
    }
    editMap((current) =>
      updateSection(current, selected.id, {
        bpm,
        ...(selected.tempoChange?.type === 'aTempo'
          ? { tempoChange: { type: 'aTempo', targetBpm: bpm } }
          : {}),
      }),
    );
    setTapStatus(`탭 평균 ${bpm} BPM`);
  };

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `feelmyrythm-${map.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (isReadOnly) {
      event.target.value = '';
      notify({ title: '읽기 전용 상태에서는 가져올 수 없습니다.', tone: 'info' });
      return;
    }
    try {
      const imported: unknown = JSON.parse(await file.text());
      assertValidTempoMap(imported);
      expandTimeline(imported);
      editMap({
        ...imported,
        id: map.id,
        repertoireItemId: map.repertoireItemId,
        revision: map.revision,
      });
      setSelectedId(imported.sections[0]?.id ?? '');
      notify({ title: '템포맵을 가져왔습니다.', tone: 'success' });
    } catch (error) {
      notify({
        title: '올바른 템포맵 JSON이 아닙니다.',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      event.target.value = '';
    }
  };

  const saveLabel = rebasedPending ? '재기준 초안 저장' : isSaving ? '저장 중…' : '저장';
  const editorActions =
    loadState === 'ready' ? (
      <>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          disabled={isReadOnly}
          onChange={(event) => void importJson(event)}
        />
        <Button onClick={() => importRef.current?.click()} disabled={isReadOnly}>
          <Upload size={17} aria-hidden /> 가져오기
        </Button>
        <Button onClick={exportJson}>
          <Download size={17} aria-hidden /> 내보내기
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={isSaving || isReadOnly}>
          <Save size={17} aria-hidden /> {saveLabel}
        </Button>
        <Button onClick={() => void navigate(playbackPath)} disabled={isSaving}>
          <Play size={17} aria-hidden /> 메트로놈에서 열기
        </Button>
        {scorePath ? (
          <Button onClick={() => void navigate(scorePath)} disabled={isSaving}>
            <BookOpen size={17} aria-hidden /> 악보로 돌아가기
          </Button>
        ) : null}
      </>
    ) : undefined;

  return (
    <div className="page editor-page" aria-busy={loadState === 'loading'}>
      <PageHeader
        eyebrow="Tempo map"
        title="템포맵 편집기"
        description="마디별 박자와 템포, 페르마타와 쉼표, 반복 진행을 연주 순서로 설계합니다."
        actions={editorActions}
      />

      {loadState === 'loading' ? (
        <Card className="loading-panel" role="status">
          로컬 초안과 서버 revision을 함께 확인하는 중…
        </Card>
      ) : null}
      {loadState === 'error' ? (
        <Card className="error-panel" role="alert">
          <strong>템포맵을 불러오지 못했습니다.</strong>
          <p>{loadError}</p>
          <Button onClick={() => setReloadKey((current) => current + 1)}>다시 시도</Button>
        </Card>
      ) : null}

      {loadState === 'ready' ? (
        <>
          {isOfflineReadOnly ? (
            <Card className="editor-offline-notice" role="status" aria-live="polite">
              <strong>오프라인 읽기 전용으로 열었습니다.</strong>
              <p>
                네트워크에 연결할 수 없어 현재 계정의 저장된 템포맵 사본을 표시합니다. 내보내기는
                가능하지만 편집·가져오기·저장은 연결을 복구한 뒤 다시 시도해 주세요.
              </p>
              <Button onClick={() => setReloadKey((current) => current + 1)}>연결 다시 확인</Button>
            </Card>
          ) : null}
          {cacheNotice ? (
            <div className="editor-cache-notice" role="status" aria-live="polite">
              {cacheNotice}
            </div>
          ) : null}
          {remoteRole === 'member' && !isOfflineReadOnly ? (
            <Card role="status">
              프로젝트 멤버는 템포맵을 읽고 재생할 수 있습니다. 구간 편집은 리더에게 요청하세요.
            </Card>
          ) : null}
          <fieldset
            disabled={isReadOnly}
            aria-label={isReadOnly ? '읽기 전용 편집기' : undefined}
            style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
          >
            <Card className="map-settings" aria-label="곡 전체 설정">
              <header>
                <div>
                  <span className="eyebrow">Whole score</span>
                  <h2>곡 전체 설정</h2>
                </div>
                <div className="cluster">
                  <StatusBadge tone={isDirty ? 'warning' : 'success'}>
                    {isDirty ? '저장 안 됨' : '저장됨'}
                  </StatusBadge>
                  <span className="revision-label">revision {map.revision}</span>
                </div>
              </header>
              <div className="map-settings__grid">
                <EditorField
                  label="총 마디 수"
                  type="number"
                  min={1}
                  value={map.totalMeasures}
                  error={issueFor(validation.issues, 'totalMeasures')}
                  onChange={(event) => {
                    const next = resizeTempoMap(map, Number(event.target.value));
                    editMap(next);
                    if (!next.sections.some((section) => section.id === selectedId)) {
                      setSelectedId(next.sections[0]?.id ?? '');
                    }
                  }}
                />
                <SelectField
                  label="예비박"
                  value={map.countIn.measures}
                  error={issueFor(validation.issues, 'countIn.measures')}
                  onChange={(event) =>
                    editMap((current) => ({
                      ...current,
                      countIn: {
                        measures: Number(event.target.value) as 1 | 2,
                        useSectionMeter: true,
                      },
                    }))
                  }
                >
                  <option value={1}>1마디</option>
                  <option value={2}>2마디</option>
                </SelectField>
                <SelectField
                  label="못갖춘마디"
                  value={map.anacrusis ? 'enabled' : 'none'}
                  error={issueFor(validation.issues, 'anacrusis', true)}
                  onChange={(event) =>
                    editMap((current) => {
                      if (event.target.value === 'enabled') {
                        return { ...current, anacrusis: current.anacrusis ?? { beats: 1 } };
                      }
                      const { anacrusis: _removed, ...withoutAnacrusis } = current;
                      void _removed;
                      return withoutAnacrusis;
                    })
                  }
                >
                  <option value="none">없음</option>
                  <option value="enabled">있음</option>
                </SelectField>
                {map.anacrusis ? (
                  <EditorField
                    label="못갖춘 박 수"
                    type="number"
                    min={1}
                    value={map.anacrusis.beats}
                    error={issueFor(validation.issues, 'anacrusis.beats')}
                    onChange={(event) =>
                      editMap((current) => ({
                        ...current,
                        anacrusis: { beats: Number(event.target.value) },
                      }))
                    }
                  />
                ) : null}
              </div>
            </Card>

            <Card className="map-settings" aria-label="마디별 연주 표현">
              <header>
                <div>
                  <span className="eyebrow">Measure expressions</span>
                  <h2>마디별 연주 표현</h2>
                </div>
                <StatusBadge>{map.measureExpressions?.length ?? 0}마디 설정</StatusBadge>
              </header>
              <p className="subtle">
                구간을 나누지 않고 원하는 마디에 직접 지정합니다. 마디 번호는 구간을 이동·나누거나
                합쳐도 유지됩니다.
              </p>
              <div className="jump-adder">
                <EditorField
                  label="표현을 추가할 마디"
                  aria-label="표현을 추가할 마디"
                  type="number"
                  min={1}
                  max={map.totalMeasures}
                  value={newExpressionMeasure}
                  error={expressionMeasureError}
                  onChange={(event) => setNewExpressionMeasure(Number(event.target.value))}
                />
                <Button onClick={addMeasureExpression} disabled={Boolean(expressionMeasureError)}>
                  <Plus size={16} aria-hidden /> 마디 표현 추가
                </Button>
              </div>
              <div className="jump-list">
                {(map.measureExpressions ?? []).map((expression, index) => (
                  <MeasureExpressionFields
                    key={index}
                    map={map}
                    expression={expression}
                    index={index}
                    issues={validation.issues}
                    onChange={(next) =>
                      editMap((current) => updateMeasureExpression(current, index, next))
                    }
                    onDelete={() =>
                      editMap((current) => ({
                        ...current,
                        measureExpressions:
                          current.measureExpressions?.filter(
                            (_, currentIndex) => currentIndex !== index,
                          ) ?? [],
                      }))
                    }
                  />
                ))}
              </div>
              {map.measureExpressions?.length ? (
                <p className="subtle">
                  마디별 설정의 페르마타·쉼표가 구간 끝 기본값보다 우선합니다. 표현 행을 삭제하면
                  구간 기본값을 다시 따릅니다.
                </p>
              ) : (
                <p className="subtle">
                  아직 마디별 표현이 없습니다. 위에서 마디 번호를 지정해 추가하세요.
                </p>
              )}
            </Card>

            <Card className="timeline-card">
              <header className="timeline-card__header">
                <div className="cluster">
                  <strong>마디 타임라인</strong>
                  {preview.error ? (
                    <StatusBadge tone="danger">전개 오류</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">유효함</StatusBadge>
                  )}
                </div>
                <div className="cluster">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="축소"
                    onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}
                  >
                    <ZoomOut size={18} aria-hidden />
                  </Button>
                  <span className="fmr-tabular">{Math.round(zoom * 100)}%</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="확대"
                    onClick={() => setZoom((current) => Math.min(3, current + 0.25))}
                  >
                    <ZoomIn size={18} aria-hidden />
                  </Button>
                  <Button variant="ghost" onClick={() => setTableMode((current) => !current)}>
                    <Braces size={18} aria-hidden /> {tableMode ? '블록' : '표'}
                  </Button>
                </div>
              </header>
              {tableMode ? (
                <div className="section-table">
                  <table aria-label="템포 구간">
                    <thead>
                      <tr>
                        <th scope="col">구간</th>
                        <th scope="col">마디</th>
                        <th scope="col">박자</th>
                        <th scope="col">BPM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {map.sections.map((section) => (
                        <tr
                          key={section.id}
                          className={
                            section.id === selected?.id ? 'section-table__row--selected' : ''
                          }
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="section-table__selector"
                              aria-pressed={section.id === selected?.id}
                              onClick={() => setSelectedId(section.id)}
                            >
                              {section.label ?? '—'}
                            </button>
                          </th>
                          <td>
                            {section.startMeasure}–{section.endMeasure}
                          </td>
                          <td>
                            {section.timeSignature.num}/{section.timeSignature.denom}
                          </td>
                          <td>
                            <div>{sectionBpm(section)}</div>
                            {sectionExpressionSummary(section) ? (
                              <small>{sectionExpressionSummary(section)}</small>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="measure-timeline">
                  <div
                    className="measure-timeline__track"
                    style={{ width: `${Math.max(100, map.totalMeasures * 18 * zoom)}px` }}
                  >
                    {map.sections.map((section, index) => {
                      const left = ((section.startMeasure - 1) / map.totalMeasures) * 100;
                      const width =
                        ((section.endMeasure - section.startMeasure + 1) / map.totalMeasures) * 100;
                      return (
                        <button
                          key={section.id}
                          className={
                            section.id === selected?.id
                              ? 'tempo-block tempo-block--selected'
                              : 'tempo-block'
                          }
                          title={sectionExpressionSummary(section) || undefined}
                          style={
                            {
                              left: `${left}%`,
                              width: `${width}%`,
                              '--section-hue': String(38 + (index % 4) * 12),
                            } as React.CSSProperties
                          }
                          onClick={() => setSelectedId(section.id)}
                        >
                          <strong>{section.label ?? `S${index + 1}`}</strong>
                          <span>
                            {section.startMeasure}–{section.endMeasure} · {sectionBpm(section)}
                          </span>
                          {sectionExpressionSummary(section) ? (
                            <span>{sectionExpressionSummary(section)}</span>
                          ) : null}
                        </button>
                      );
                    })}
                    {map.jumps
                      .filter((jump) => jump.type === 'repeat')
                      .map((jump, index) => (
                        <div
                          key={index}
                          className="repeat-arch"
                          style={{
                            left: `${((jump.startMeasure - 1) / map.totalMeasures) * 100}%`,
                            width: `${((jump.endMeasure - jump.startMeasure + 1) / map.totalMeasures) * 100}%`,
                          }}
                          aria-label={`${jump.startMeasure}–${jump.endMeasure}마디 ${jump.times}회 반복`}
                        >
                          ×{jump.times}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              <footer
                className="timeline-preview"
                role={preview.error ? 'alert' : 'status'}
                aria-live="polite"
              >
                {preview.timeline ? (
                  <>
                    연주 순서로 <strong>{preview.timeline.entries.length}마디</strong> ·{' '}
                    <strong>
                      {Math.floor(preview.timeline.totalDurationSec / 60)}분{' '}
                      {Math.round(preview.timeline.totalDurationSec % 60)}초
                    </strong>
                  </>
                ) : (
                  <span className="error-text">{preview.error}</span>
                )}
              </footer>
            </Card>

            {!validation.valid ? (
              <Card className="validation-summary" role="alert" aria-labelledby="validation-title">
                <strong id="validation-title">
                  저장 전 해결할 항목 {validation.issues.length}개
                </strong>
                <ul>
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${issue.code}-${index}`}>
                      <code>{issue.path}</code> — {friendlyIssue(issue)}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {rebasedPending ? (
              <div className="editor-rebase-notice" role="status" aria-live="polite">
                서버 revision {map.revision}에 재기준했습니다. 내용을 검토한 뒤 ‘재기준 초안 저장’을
                눌러 명시적으로 반영하세요.
              </div>
            ) : null}

            {undoDelete ? (
              <div className="editor-undo" role="status" aria-live="polite">
                <span>‘{undoDelete.label}’ 구간을 삭제했습니다.</span>
                <Button
                  onClick={() => {
                    editMap(undoDelete.map);
                    setSelectedId(undoDelete.selectedId);
                    setUndoDelete(undefined);
                  }}
                >
                  <RotateCcw size={16} aria-hidden /> 삭제 취소
                </Button>
              </div>
            ) : null}

            {selected ? (
              <div className="editor-grid">
                <Card className="section-properties">
                  <header>
                    <div>
                      <span className="eyebrow">Selected section</span>
                      <h2>{selected.label ?? '이름 없는 구간'}</h2>
                    </div>
                    <div className="cluster section-order-actions">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="구간 위로 이동"
                        disabled={selectedIndex <= 0}
                        onClick={() =>
                          editMap((current) => moveTempoSection(current, selected.id, -1))
                        }
                      >
                        <ChevronUp size={18} aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="구간 아래로 이동"
                        disabled={selectedIndex >= map.sections.length - 1}
                        onClick={() =>
                          editMap((current) => moveTempoSection(current, selected.id, 1))
                        }
                      >
                        <ChevronDown size={18} aria-hidden />
                      </Button>
                    </div>
                  </header>
                  <div className="property-grid">
                    <EditorField
                      label="구간 이름"
                      value={selected.label ?? ''}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].label`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, { label: event.target.value }),
                        )
                      }
                    />
                    <EditorField
                      label="BPM"
                      type="number"
                      min={20}
                      max={400}
                      value={sectionBpm(selected)}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].bpm`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, {
                            bpm: Number(event.target.value),
                            ...(selected.tempoChange?.type === 'aTempo'
                              ? {
                                  tempoChange: {
                                    type: 'aTempo',
                                    targetBpm: Number(event.target.value),
                                  },
                                }
                              : {}),
                          }),
                        )
                      }
                    />
                    <div className="tap-tempo-field">
                      <span className="fmr-field__label">탭 템포</span>
                      <Button onClick={tapTempo}>탭 템포</Button>
                      <small aria-live="polite">{tapStatus}</small>
                    </div>
                    <EditorField
                      label="시작 마디"
                      type="number"
                      value={selected.startMeasure}
                      readOnly
                      error={issueFor(validation.issues, `sections[${selectedIndex}].startMeasure`)}
                    />
                    <EditorField
                      label="끝 마디"
                      type="number"
                      value={selected.endMeasure}
                      readOnly
                      error={issueFor(validation.issues, `sections[${selectedIndex}].endMeasure`)}
                    />
                    <EditorField
                      label="박자 분자"
                      type="number"
                      min={1}
                      max={32}
                      value={selected.timeSignature.num}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].timeSignature.num`,
                      )}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            timeSignature: {
                              ...selected.timeSignature,
                              num: Number(event.target.value),
                            },
                          }),
                        )
                      }
                    />
                    <SelectField
                      label="박자 분모"
                      value={selected.timeSignature.denom}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].timeSignature.denom`,
                      )}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            timeSignature: {
                              ...selected.timeSignature,
                              denom: Number(event.target.value),
                            },
                          }),
                        )
                      }
                    >
                      {[2, 4, 8, 16].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="박 단위"
                      value={selected.beatUnit}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].beatUnit`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSectionMeter(current, selected.id, {
                            beatUnit: event.target.value as TempoSection['beatUnit'],
                          }),
                        )
                      }
                    >
                      {Object.entries(NOTE_VALUE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="분할 클릭"
                      value={selected.subdivision ?? 1}
                      error={issueFor(validation.issues, `sections[${selectedIndex}].subdivision`)}
                      onChange={(event) =>
                        editMap((current) =>
                          updateSection(current, selected.id, {
                            subdivision: Number(event.target.value) as 1 | 2 | 3 | 4,
                          }),
                        )
                      }
                    >
                      {[1, 2, 3, 4].map((value) => (
                        <option key={value} value={value}>
                          {value}분할
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="템포 변화"
                      value={selected.tempoChange?.type ?? 'none'}
                      error={issueFor(
                        validation.issues,
                        `sections[${selectedIndex}].tempoChange`,
                        true,
                      )}
                      onChange={(event) => {
                        const type = event.target.value;
                        editMap((current) => {
                          if (type === 'none') {
                            return removeSectionExpression(current, selected.id, 'tempoChange');
                          }
                          const targetBpm =
                            type === 'aTempo'
                              ? restoredTempo(current, selected)
                              : type === 'rit'
                                ? Math.max(1, selected.bpm - 10)
                                : selected.bpm + 10;
                          return updateSection(current, selected.id, {
                            ...(type === 'aTempo' ? { bpm: targetBpm } : {}),
                            tempoChange: {
                              type: type as NonNullable<TempoSection['tempoChange']>['type'],
                              targetBpm,
                            },
                          });
                        });
                      }}
                    >
                      <option value="none">없음</option>
                      <option value="rit">리타르단도 · rit. (점점 느리게)</option>
                      <option value="accel">아첼레란도 · accel. (점점 빠르게)</option>
                      <option value="aTempo">아 템포 · a tempo (원래 빠르기로)</option>
                    </SelectField>
                    {selected.tempoChange ? (
                      <EditorField
                        label={selected.tempoChange.type === 'aTempo' ? '복귀 BPM' : '도착 BPM'}
                        aria-label={
                          selected.tempoChange.type === 'aTempo' ? '복귀 BPM' : '도착 BPM'
                        }
                        hint={
                          selected.tempoChange.type === 'aTempo'
                            ? '이 구간 첫 박부터 적용합니다. 기본값은 앞선 템포 변화 전의 빠르기이며 직접 바꿀 수 있습니다.'
                            : '이 구간 전체에 걸쳐 도착 BPM까지 점차 바뀝니다.'
                        }
                        type="number"
                        min={20}
                        max={400}
                        value={selected.tempoChange.targetBpm}
                        error={
                          issueFor(
                            validation.issues,
                            `sections[${selectedIndex}].tempoChange.targetBpm`,
                          ) ?? issueFor(validation.issues, `sections[${selectedIndex}].tempoChange`)
                        }
                        onChange={(event) =>
                          editMap((current) =>
                            updateSection(current, selected.id, {
                              ...(selected.tempoChange?.type === 'aTempo'
                                ? { bpm: Number(event.target.value) }
                                : {}),
                              tempoChange: {
                                ...selected.tempoChange!,
                                targetBpm: Number(event.target.value),
                              },
                            }),
                          )
                        }
                      />
                    ) : null}
                  </div>
                  <fieldset className="accent-editor">
                    <legend>구간 끝 기본 표현</legend>
                    <p>
                      {selected.endMeasure}마디의 기본값입니다. 원하는 마디·박에 직접 넣으려면 위의
                      마디별 연주 표현을 사용하세요. 같은 마디에 마디별 설정이 있으면 해당 설정의
                      페르마타·쉼표가 우선합니다.
                    </p>
                    <div className="property-grid">
                      <CheckboxField
                        label="페르마타"
                        hint="구간 마지막 마디의 박을 지정한 박 수만큼 더 늘입니다."
                        checked={Boolean(selected.fermata)}
                        onChange={(checked) =>
                          editMap((current) =>
                            checked
                              ? updateSection(current, selected.id, { fermata: { extraBeats: 1 } })
                              : removeSectionExpression(current, selected.id, 'fermata'),
                          )
                        }
                      />
                      {selected.fermata ? (
                        <EditorField
                          label="추가로 늘일 박 수"
                          aria-label="추가로 늘일 박 수"
                          type="number"
                          min={0}
                          max={16}
                          step="any"
                          value={selected.fermata.extraBeats}
                          hint="0보다 크고 16 이하 · 예: 0.5박, 1박"
                          error={issueFor(
                            validation.issues,
                            `sections[${selectedIndex}].fermata`,
                            true,
                          )}
                          onChange={(event) =>
                            editMap((current) =>
                              updateSection(current, selected.id, {
                                fermata: {
                                  ...selected.fermata!,
                                  extraBeats: Number(event.target.value),
                                },
                              }),
                            )
                          }
                        />
                      ) : null}
                      <CheckboxField
                        label="쉼표 · 숨 고르기"
                        hint="구간이 끝나면 잠시 쉰 뒤 자동으로 다시 시작합니다."
                        checked={Boolean(selected.breath)}
                        onChange={(checked) =>
                          editMap((current) =>
                            checked
                              ? updateSection(current, selected.id, {
                                  breath: { durationSec: 2, countIn: true },
                                })
                              : removeSectionExpression(current, selected.id, 'breath'),
                          )
                        }
                      />
                      {selected.breath ? (
                        <>
                          <EditorField
                            label="쉬는 시간 (초)"
                            aria-label="쉬는 시간 (초)"
                            type="number"
                            min={0}
                            max={300}
                            step="any"
                            value={selected.breath.durationSec}
                            hint="0보다 크고 300 이하 · 예비박 시간은 별도입니다."
                            error={issueFor(
                              validation.issues,
                              `sections[${selectedIndex}].breath.durationSec`,
                            )}
                            onChange={(event) =>
                              editMap((current) =>
                                updateSection(current, selected.id, {
                                  breath: {
                                    ...selected.breath!,
                                    durationSec: Number(event.target.value),
                                  },
                                }),
                              )
                            }
                          />
                          <CheckboxField
                            label="재개 전 예비박"
                            hint={`쉰 뒤 다음 구간의 박자·빠르기로 ${map.countIn.measures}마디를 듣습니다. 연주가 끝나면 생략합니다.`}
                            checked={selected.breath.countIn}
                            onChange={(checked) =>
                              editMap((current) =>
                                updateSection(current, selected.id, {
                                  breath: { ...selected.breath!, countIn: checked },
                                }),
                              )
                            }
                          />
                        </>
                      ) : null}
                    </div>
                  </fieldset>
                  <fieldset className="accent-editor">
                    <legend>박별 강세 패턴</legend>
                    <p>0은 무음, 1은 일반 박, 2는 강박입니다.</p>
                    <div className="accent-grid">
                      {(selected.accentPattern ?? accentsFor(selected)).map((accent, index) => (
                        <SelectField
                          key={index}
                          label={`${index + 1}박`}
                          value={accent}
                          error={issueFor(
                            validation.issues,
                            `sections[${selectedIndex}].accentPattern[${index}]`,
                          )}
                          onChange={(event) => {
                            const pattern = [...(selected.accentPattern ?? accentsFor(selected))];
                            pattern[index] = Number(event.target.value) as Accent;
                            editMap((current) =>
                              updateSection(current, selected.id, { accentPattern: pattern }),
                            );
                          }}
                        >
                          <option value={0}>0 · 무음</option>
                          <option value={1}>1 · 보통</option>
                          <option value={2}>2 · 강박</option>
                        </SelectField>
                      ))}
                    </div>
                    {issueFor(
                      validation.issues,
                      `sections[${selectedIndex}].accentPattern`,
                      true,
                    ) ? (
                      <p className="inline-issue">
                        {issueFor(
                          validation.issues,
                          `sections[${selectedIndex}].accentPattern`,
                          true,
                        )}
                      </p>
                    ) : null}
                  </fieldset>
                  <div className="section-actions">
                    <Button
                      onClick={() => {
                        setSplitMeasure(Math.min(selected.endMeasure, selected.startMeasure + 1));
                        setSplitOpen(true);
                      }}
                      disabled={selected.startMeasure === selected.endMeasure}
                    >
                      <Scissors size={17} aria-hidden /> 구간 나누기
                    </Button>
                    <Button
                      onClick={mergePrevious}
                      disabled={selectedIndex <= 0 || mergeBlockedByExpression}
                    >
                      <GitMerge size={17} aria-hidden /> 이전과 합치기
                    </Button>
                    <Button
                      variant="danger"
                      onClick={removeSection}
                      disabled={map.sections.length === 1}
                    >
                      <Trash2 size={17} aria-hidden /> 삭제
                    </Button>
                  </div>
                  {mergeBlockedByExpression ? (
                    <p className="subtle">
                      이전 구간 끝의 페르마타·쉼표를 먼저 해제해야 합칠 수 있습니다. 합치면 중간
                      경계가 사라지므로 해당 표현을 보존할 수 없습니다.
                    </p>
                  ) : null}
                </Card>

                <Card className="jump-panel">
                  <header>
                    <div>
                      <span className="eyebrow">Playback order</span>
                      <h2>반복과 이동</h2>
                    </div>
                  </header>
                  <div className="jump-adder">
                    <SelectField
                      label="새 진행 지시"
                      ariaLabel="새 이동 지시 종류"
                      value={newJumpType}
                      onChange={(event) => setNewJumpType(event.target.value as JumpType)}
                    >
                      {Object.entries(JUMP_LABELS).map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      aria-label={`${JUMP_LABELS[newJumpType]} 추가`}
                      onClick={() =>
                        editMap((current) => ({
                          ...current,
                          jumps: [...current.jumps, createJump(newJumpType, current, selected)],
                        }))
                      }
                    >
                      <Plus size={18} aria-hidden /> 추가
                    </Button>
                  </div>
                  {issueFor(validation.issues, 'jumps', true) ? (
                    <p className="inline-issue">{issueFor(validation.issues, 'jumps', true)}</p>
                  ) : null}
                  {map.jumps.length === 0 ? (
                    <p className="subtle">반복, D.C./D.S., Fine, Coda 지시가 없습니다.</p>
                  ) : (
                    <div className="jump-list">
                      {map.jumps.map((jump, index) => (
                        <fieldset className="jump-editor" key={`${index}-${jump.type}`}>
                          <legend>
                            {index + 1}. {JUMP_LABELS[jump.type]}
                          </legend>
                          <div className="jump-editor__header">
                            <SelectField
                              label="지시 종류"
                              value={jump.type}
                              onChange={(event) =>
                                editMap((current) =>
                                  updateJump(
                                    current,
                                    index,
                                    createJump(event.target.value as JumpType, current, selected),
                                  ),
                                )
                              }
                            >
                              {Object.entries(JUMP_LABELS).map(([type, label]) => (
                                <option key={type} value={type}>
                                  {label}
                                </option>
                              ))}
                            </SelectField>
                            <Button
                              variant="ghost"
                              aria-label={`${JUMP_LABELS[jump.type]} 삭제`}
                              onClick={() =>
                                editMap((current) => ({
                                  ...current,
                                  jumps: current.jumps.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={16} aria-hidden /> 지시 삭제
                            </Button>
                          </div>
                          <JumpFields
                            jump={jump}
                            index={index}
                            map={map}
                            issues={validation.issues}
                            onChange={(next) =>
                              editMap((current) => updateJump(current, index, next))
                            }
                          />
                        </fieldset>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ) : null}

            <div className="editor-save-bar" aria-live="polite">
              <span>
                {rebasedPending
                  ? `서버 revision ${map.revision}에 재기준했습니다. 검토 후 명시적으로 저장하세요.`
                  : isDirty
                    ? '저장되지 않은 변경이 있습니다.'
                    : `revision ${map.revision} 저장됨`}
              </span>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={isSaving || isReadOnly}
              >
                <Save size={17} aria-hidden /> {saveLabel}
              </Button>
            </div>
          </fieldset>
        </>
      ) : null}

      <Modal
        open={blocker.state === 'blocked' && !saveConflict}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked' && !saveConflict) blocker.reset();
        }}
        title="저장하지 않은 변경이 있습니다"
        description="다른 화면으로 이동하기 전에 변경을 저장하거나 버릴지 선택하세요."
      >
        <div className="conflict-actions editor-navigation-actions">
          <Button
            variant="primary"
            onClick={() => void saveAndContinueNavigation()}
            disabled={isSaving}
          >
            <Save size={17} aria-hidden /> {isSaving ? '저장 중…' : '저장 후 이동'}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (blocker.state === 'blocked') blocker.proceed();
            }}
            disabled={isSaving}
          >
            변경 버리고 이동
          </Button>
          <Button
            onClick={() => {
              if (blocker.state === 'blocked') blocker.reset();
            }}
            disabled={isSaving}
          >
            계속 편집
          </Button>
        </div>
      </Modal>

      <Modal
        open={splitOpen}
        onOpenChange={setSplitOpen}
        title="구간 나누기"
        description="입력한 마디부터 새 구간이 시작되며 양쪽 경계는 빈틈 없이 보존됩니다."
      >
        <div className="stack">
          <EditorField
            label="새 구간 시작 마디"
            type="number"
            min={(selected?.startMeasure ?? 1) + 1}
            max={selected?.endMeasure}
            value={splitMeasure}
            onChange={(event) => setSplitMeasure(Number(event.target.value))}
          />
          <Button variant="primary" onClick={split}>
            <Scissors size={18} aria-hidden /> 나누기
          </Button>
        </div>
      </Modal>

      <Modal
        open={Boolean(loadConflict)}
        onOpenChange={() => undefined}
        title="같은 revision의 내용이 다릅니다"
        description="로컬 초안과 서버본 중 사용할 내용을 직접 선택해야 합니다. 자동으로 덮어쓰지 않습니다."
      >
        {loadConflict ? (
          <div className="conflict-dialog">
            <div className="conflict-compare">
              <div>
                <strong>로컬 초안 · revision {loadConflict.local.revision}</strong>
                <span>첫 구간 {loadConflict.local.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
              <div>
                <strong>서버본 · revision {loadConflict.server.revision}</strong>
                <span>첫 구간 {loadConflict.server.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
            </div>
            <div className="conflict-actions">
              <Button
                onClick={() => {
                  const chosen = loadConflict.local;
                  setMap(chosen);
                  setSelectedId(chosen.sections[0]?.id ?? '');
                  setSavedFingerprint(fingerprint(loadConflict.server));
                  setLoadConflict(undefined);
                  void cacheMap(chosen);
                }}
              >
                로컬 초안 사용
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const chosen = loadConflict.server;
                  setLoadConflict(undefined);
                  void applyServerMap(chosen);
                }}
              >
                서버본 사용
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(saveConflict)}
        onOpenChange={() => undefined}
        title="저장 충돌을 해결하세요"
        description="다른 멤버가 먼저 저장했습니다. 서버 최신본을 사용하거나 내 초안을 최신 revision에 재기준할 수 있습니다."
      >
        {saveConflict ? (
          <div className="conflict-dialog">
            <div className="conflict-compare">
              <div>
                <strong>내 초안 · revision {saveConflict.draft.revision}</strong>
                <span>첫 구간 {saveConflict.draft.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
              <div>
                <strong>서버 최신본 · revision {saveConflict.latest.revision}</strong>
                <span>첫 구간 {saveConflict.latest.sections[0]?.bpm ?? '—'} BPM</span>
              </div>
            </div>
            <p className="subtle">
              재기준은 아직 저장이 아닙니다. 편집기로 돌아가 내용을 검토한 뒤 ‘재기준 초안 저장’을
              눌러야 서버에 반영됩니다.
            </p>
            <div className="conflict-actions">
              <Button
                onClick={() => {
                  const latest = saveConflict.latest;
                  setSaveConflict(undefined);
                  void applyServerMap(latest);
                }}
              >
                서버 최신본 불러오기
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const { rebased, latest } = saveConflict;
                  setMap(rebased);
                  setSelectedId(rebased.sections[0]?.id ?? '');
                  setServerSnapshot(latest);
                  setSavedFingerprint(fingerprint(latest));
                  setRebasedPending(true);
                  setSaveConflict(undefined);
                  void cacheMap(rebased);
                }}
              >
                내 초안을 최신 revision에 재기준
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
