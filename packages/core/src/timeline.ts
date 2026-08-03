/**
 * 템포맵 → PerformanceTimeline 컴파일 (설계문서 §4.3).
 * 반복 구조(도돌이·볼타·D.C./D.S./Coda)를 연주 순서대로 펼친다.
 * 모두 순수 함수 — 같은 입력이면 어느 기기에서든 같은 결과 (동기화의 전제).
 */
import {
  NOTE_VALUE_FRACTION,
  type CountInBeat,
  type JumpDirective,
  type PerformanceTimeline,
  type TempoMap,
  type TempoSection,
  type TimelineBeat,
} from './types';

type RepeatJump = Extract<JumpDirective, { type: 'repeat' }>;
type DcDsJump = Extract<JumpDirective, { type: 'dc' | 'ds' }>;
type CodaJump = Extract<JumpDirective, { type: 'coda' }>;

// ---------- 검증 ----------

/** 편집기 표시용: 치명적/경고 이슈 목록. 비어 있으면 유효. */
export function validateTempoMap(map: TempoMap): string[] {
  const issues: string[] = [];
  if (map.totalMeasures < 1) issues.push('총 마디 수는 1 이상이어야 합니다');
  if (map.sections.length === 0) {
    issues.push('구간이 최소 1개 필요합니다');
    return issues;
  }
  const sorted = [...map.sections].sort((a, b) => a.startMeasure - b.startMeasure);
  if (sorted[0]!.startMeasure !== 1) issues.push('첫 구간은 1마디부터 시작해야 합니다');
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (s.endMeasure < s.startMeasure) issues.push(`구간 ${s.label ?? s.id}: 끝마디가 시작마디보다 앞입니다`);
    if (s.bpm <= 0 || s.bpm > 500) issues.push(`구간 ${s.label ?? s.id}: BPM(${s.bpm})이 유효 범위(1~500)를 벗어났습니다`);
    if (s.timeSignature.num < 1 || s.timeSignature.denom < 1)
      issues.push(`구간 ${s.label ?? s.id}: 박자표가 잘못되었습니다`);
    const next = sorted[i + 1];
    if (next && next.startMeasure !== s.endMeasure + 1)
      issues.push(`구간 사이에 빈틈/겹침: ${s.endMeasure}마디 다음이 ${next.startMeasure}마디`);
  }
  if (sorted[sorted.length - 1]!.endMeasure !== map.totalMeasures)
    issues.push(`마지막 구간이 총 마디 수(${map.totalMeasures})까지 덮지 않습니다`);
  for (const j of map.jumps) {
    if (j.type === 'repeat') {
      if (j.times < 2) issues.push('반복 횟수는 2 이상이어야 합니다');
      if (j.endMeasure < j.startMeasure) issues.push('반복 구간이 뒤집혀 있습니다');
    }
  }
  return issues;
}

function assertValid(map: TempoMap): void {
  const issues = validateTempoMap(map);
  if (issues.length > 0) throw new Error(`템포맵 검증 실패: ${issues.join(' / ')}`);
}

// ---------- 연주 순서 전개 ----------

interface OrderItem {
  measure: number;
  pass: number;
}

function passEnd(r: RepeatJump, pass: number): number {
  if (!r.endings || r.endings.length === 0) return r.endMeasure;
  const e = r.endings.find((e) => e.forPass.includes(pass));
  return e ? e.measures[1] : r.endMeasure;
}

/** 현재 패스에 해당하지 않는 엔딩(볼타) 구간이면 건너뛸 목적지 반환 */
function voltaSkipTarget(
  m: number,
  repeats: RepeatJump[],
  passDone: Map<RepeatJump, number>,
  dcTaken: boolean,
): number | null {
  for (const r of repeats) {
    if (!r.endings) continue;
    // D.C./D.S. 이후에는 반복을 생략하고 마지막 엔딩을 연주하는 것이 관례
    const currentPass = dcTaken ? r.times : (passDone.get(r) ?? 0) + 1;
    for (const e of r.endings) {
      if (m >= e.measures[0] && m <= e.measures[1] && !e.forPass.includes(currentPass)) {
        return e.measures[1] + 1;
      }
    }
  }
  return null;
}

export function buildPerformanceOrder(map: TempoMap): OrderItem[] {
  const repeats = map.jumps.filter((j): j is RepeatJump => j.type === 'repeat');
  const dcds = map.jumps.find((j): j is DcDsJump => j.type === 'dc' || j.type === 'ds');
  const coda = map.jumps.find((j): j is CodaJump => j.type === 'coda');

  const passDone = new Map<RepeatJump, number>();
  const timesPlayed = new Map<number, number>();
  const order: OrderItem[] = [];
  let dcTaken = false;
  let m = 1;
  let iter = 0;
  const maxIter = Math.max(256, map.totalMeasures * 64);

  while (m >= 1 && m <= map.totalMeasures) {
    if (++iter > maxIter)
      throw new Error('반복 구조가 무한 루프를 만듭니다. jumps 설정을 확인하세요.');

    const skip = voltaSkipTarget(m, repeats, passDone, dcTaken);
    if (skip !== null) {
      m = skip;
      continue;
    }

    const pass = (timesPlayed.get(m) ?? 0) + 1;
    timesPlayed.set(m, pass);
    order.push({ measure: m, pass });

    // 1) D.C./D.S. 이후 Fine 도달 → 종료
    if (dcTaken && dcds?.alFine === m) break;

    // 2) D.C./D.S. 이후 To Coda 도달 → Coda로 점프
    if (dcTaken && dcds?.alCoda && coda && coda.toCodaMeasure === m) {
      m = coda.codaMeasure;
      continue;
    }

    // 3) 도돌이 점프백 (D.C./D.S. 이후에는 반복 생략이 관례)
    if (!dcTaken) {
      let jumped = false;
      for (const r of repeats) {
        const done = passDone.get(r) ?? 0;
        const current = done + 1;
        if (current >= r.times) continue;
        if (passEnd(r, current) === m) {
          passDone.set(r, current);
          m = r.startMeasure;
          jumped = true;
          break;
        }
      }
      if (jumped) continue;
    }

    // 4) D.C. / D.S. (한 번만 실행)
    if (!dcTaken && dcds && dcds.atMeasure === m) {
      dcTaken = true;
      m = dcds.type === 'dc' ? 1 : dcds.segnoMeasure;
      continue;
    }

    m += 1;
  }
  return order;
}

// ---------- 시간 계산 ----------

export function sectionForMeasure(map: TempoMap, measure: number): TempoSection | undefined {
  return map.sections.find((s) => measure >= s.startMeasure && measure <= s.endMeasure);
}

/** 구간의 박 구성: 마디당 몇 박, 1박이 온음표의 몇 분의 몇인지 */
function beatScheme(sec: TempoSection): { count: number; unitFrac: number } {
  const unit = NOTE_VALUE_FRACTION[sec.beatUnit];
  const measureFrac = sec.timeSignature.num / sec.timeSignature.denom;
  const raw = measureFrac / unit;
  if (Math.abs(raw - Math.round(raw)) < 1e-9 && Math.round(raw) >= 1) {
    return { count: Math.round(raw), unitFrac: unit };
  }
  // beatUnit으로 나누어떨어지지 않으면(예: 7/8을 quarter로) 분모 음가 단위로 폴백
  return { count: sec.timeSignature.num, unitFrac: 1 / sec.timeSignature.denom };
}

function bpmForMeasure(sec: TempoSection, measure: number): number {
  if (!sec.tempoChange) return sec.bpm;
  const span = sec.endMeasure - sec.startMeasure;
  if (span === 0) return sec.tempoChange.targetBpm;
  const t = (measure - sec.startMeasure) / span;
  return sec.bpm + (sec.tempoChange.targetBpm - sec.bpm) * t;
}

function accentFor(sec: TempoSection, beatIndex: number): 0 | 1 | 2 {
  if (sec.accentPattern && sec.accentPattern.length > 0) {
    const v = sec.accentPattern[beatIndex % sec.accentPattern.length] ?? 1;
    return Math.max(0, Math.min(2, Math.round(v))) as 0 | 1 | 2;
  }
  return beatIndex === 0 ? 2 : 1;
}

/** 특정 마디의 박 시간 정보 (예비박 생성에도 재사용) */
function measureBeatTiming(sec: TempoSection, measure: number): { count: number; beatSec: number } {
  const scheme = beatScheme(sec);
  const bpm = bpmForMeasure(sec, measure);
  const wholeNoteSec = (60 / bpm) / NOTE_VALUE_FRACTION[sec.beatUnit];
  return { count: scheme.count, beatSec: wholeNoteSec * scheme.unitFrac };
}

export function expandTimeline(map: TempoMap): PerformanceTimeline {
  assertValid(map);
  const order = buildPerformanceOrder(map);
  const entries: PerformanceTimeline['entries'] = [];
  let t = 0;

  for (const item of order) {
    const sec = sectionForMeasure(map, item.measure)!;
    const { count: fullCount, beatSec } = measureBeatTiming(sec, item.measure);
    let count = fullCount;
    if (item.measure === 1 && item.pass === 1 && map.anacrusis) {
      count = Math.max(1, Math.min(fullCount, Math.round(map.anacrusis.beats)));
    }
    const subdiv = sec.subdivision ?? 1;
    const beats: TimelineBeat[] = [];
    for (let b = 0; b < count; b++) {
      beats.push({ timeSec: t + b * beatSec, accent: accentFor(sec, b), isSubdivision: false });
      for (let s = 1; s < subdiv; s++) {
        beats.push({ timeSec: t + b * beatSec + (s * beatSec) / subdiv, accent: 0, isSubdivision: true });
      }
    }
    const durationSec = count * beatSec;
    entries.push({
      measureNumber: item.measure,
      pass: item.pass,
      sectionId: sec.id,
      startTimeSec: t,
      durationSec,
      beats,
    });
    t += durationSec;
  }

  return { tempoMapRevision: map.revision, entries, totalDurationSec: t };
}

// ---------- 위치 탐색 ----------

export interface TimelinePosition {
  entryIndex: number;
  beatIndex: number;
}

/** 경과 시간(초) → 현재 마디·박 (이진 탐색) */
export function locate(tl: PerformanceTimeline, elapsedSec: number): TimelinePosition | null {
  const { entries } = tl;
  if (entries.length === 0 || elapsedSec < 0 || elapsedSec >= tl.totalDurationSec) return null;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid]!.startTimeSec <= elapsedSec) lo = mid;
    else hi = mid - 1;
  }
  const entry = entries[lo]!;
  let beatIndex = 0;
  for (let i = entry.beats.length - 1; i >= 0; i--) {
    if (entry.beats[i]!.timeSec <= elapsedSec + 1e-9) {
      beatIndex = i;
      break;
    }
  }
  return { entryIndex: lo, beatIndex };
}

/** "measure마디 pass번째 패스부터" → 타임라인 오프셋(초) */
export function seekPoint(tl: PerformanceTimeline, measure: number, pass = 1): number {
  const idx = tl.entries.findIndex((e) => e.measureNumber === measure && e.pass === pass);
  if (idx < 0) throw new Error(`타임라인에 ${measure}마디(패스 ${pass})가 없습니다`);
  return tl.entries[idx]!.startTimeSec;
}

// ---------- 예비박 ----------

/**
 * 예비박 생성 (설계문서 §5.3).
 * 시작 지점 구간의 박자·템포로 countIn.measures 마디를 앵커 앞(음수 시간)에 배치.
 * 반환된 첫 박의 timeSec 절대값이 예비박 총 길이다.
 */
export function buildCountIn(map: TempoMap, anchorMeasure: number): CountInBeat[] {
  const sec = sectionForMeasure(map, anchorMeasure);
  if (!sec) throw new Error(`${anchorMeasure}마디를 포함하는 구간이 없습니다`);
  const { count, beatSec } = measureBeatTiming(sec, anchorMeasure);
  const measures = map.countIn.measures;
  const beats: CountInBeat[] = [];
  const total = measures * count;
  for (let i = 0; i < total; i++) {
    const beatInMeasure = i % count;
    beats.push({
      timeSec: -(total - i) * beatSec,
      accent: beatInMeasure === 0 ? 2 : 1,
      countdown: count - beatInMeasure,
    });
  }
  return beats;
}
