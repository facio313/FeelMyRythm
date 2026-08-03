/**
 * MusicXML 파싱 → 템포맵 초안 자동 생성 (설계문서 §7.1).
 * 마디 수·박자표·템포 지시·도돌이/엔딩을 추출한다. 베스트 에포트 — 결과는 편집기에서 확인.
 */
import type { JumpDirective, NoteValue, TempoMap, TempoSection } from '@feelmyrythm/core';
import { strFromU8, unzipSync } from 'fflate';

export interface MusicXmlResult {
  totalMeasures: number;
  sections: TempoSection[];
  jumps: JumpDirective[];
  title?: string;
  warnings: string[];
}

function beatUnitFor(num: number, denom: number): NoteValue {
  if (denom === 8 && num % 3 === 0) return 'dottedQuarter';
  if (denom === 8) return 'eighth';
  if (denom === 2) return 'half';
  return 'quarter';
}

async function extractXmlText(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith('.mxl')) {
    const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const entry = Object.keys(zip).find(
      (name) => !name.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(name),
    );
    if (!entry) throw new Error('.mxl 안에서 MusicXML 파일을 찾지 못했습니다');
    return strFromU8(zip[entry]!);
  }
  return await file.text();
}

export async function parseMusicXml(file: File): Promise<MusicXmlResult> {
  const xmlText = await extractXmlText(file);
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('MusicXML 파싱 실패 (XML 형식 오류)');

  const warnings: string[] = [];
  const title = doc.querySelector('work > work-title')?.textContent?.trim() || undefined;

  const firstPart = doc.querySelector('part');
  if (!firstPart) throw new Error('<part>를 찾지 못했습니다 (score-partwise만 지원)');
  const measures = Array.from(firstPart.querySelectorAll(':scope > measure'));
  if (measures.length === 0) throw new Error('마디가 없습니다');

  // 마디별 상태 수집 (직전 값 유지)
  interface MState {
    num: number;
    denom: number;
    bpm: number;
  }
  let cur: MState = { num: 4, denom: 4, bpm: 100 };
  let sawTempo = false;
  const perMeasure: MState[] = [];

  interface RepeatDraft {
    startMeasure: number;
    endMeasure: number;
    times: number;
    endings: { measures: [number, number]; forPass: number[] }[];
  }
  const repeats: RepeatDraft[] = [];
  const forwardStack: number[] = [];
  let openEnding: { start: number; numbers: number[] } | null = null;
  const pendingEndings: { measures: [number, number]; forPass: number[] }[] = [];

  measures.forEach((m, idx) => {
    const n = idx + 1;

    const timeEl = m.querySelector('attributes > time');
    if (timeEl) {
      const num = Number(timeEl.querySelector('beats')?.textContent);
      const denom = Number(timeEl.querySelector('beat-type')?.textContent);
      if (num > 0 && denom > 0) cur = { ...cur, num, denom };
    }

    // 템포: <sound tempo="..."> 또는 <metronome><per-minute>
    const soundTempo = m.querySelector('sound[tempo]')?.getAttribute('tempo');
    const perMinute = m.querySelector('direction metronome per-minute')?.textContent;
    const tempo = Number(soundTempo ?? perMinute);
    if (Number.isFinite(tempo) && tempo > 0) {
      cur = { ...cur, bpm: Math.round(tempo) };
      sawTempo = true;
    }

    // 도돌이 · 엔딩
    for (const barline of Array.from(m.querySelectorAll('barline'))) {
      const repeat = barline.querySelector('repeat');
      const ending = barline.querySelector('ending');
      if (ending) {
        const numbers = (ending.getAttribute('number') ?? '1')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((v) => v > 0);
        const type = ending.getAttribute('type');
        if (type === 'start') openEnding = { start: n, numbers };
        else if ((type === 'stop' || type === 'discontinue') && openEnding) {
          pendingEndings.push({ measures: [openEnding.start, n], forPass: openEnding.numbers });
          openEnding = null;
        }
      }
      if (repeat) {
        const dir = repeat.getAttribute('direction');
        if (dir === 'forward') forwardStack.push(n);
        else if (dir === 'backward') {
          const start = forwardStack.pop() ?? 1;
          const times = Number(repeat.getAttribute('times')) || 2;
          repeats.push({ startMeasure: start, endMeasure: n, times, endings: [] });
        }
      }
    }

    perMeasure.push(cur);
  });

  // 엔딩을 해당 범위를 덮는 도돌이에 연결
  for (const e of pendingEndings) {
    const owner = repeats.find((r) => e.measures[0] > r.startMeasure && e.measures[0] <= r.endMeasure + 4);
    if (owner) {
      owner.endings.push(e);
      owner.endMeasure = Math.max(owner.endMeasure, e.measures[1] - (e.measures[1] > owner.endMeasure ? 0 : 0));
    } else {
      warnings.push(`${e.measures[0]}~${e.measures[1]}마디 엔딩을 연결할 도돌이를 찾지 못했습니다`);
    }
  }
  // 2nd 엔딩이 도돌이 범위 밖이면 범위 확장
  for (const r of repeats) {
    for (const e of r.endings) r.endMeasure = Math.max(r.endMeasure, e.measures[1]);
  }

  if (!sawTempo) warnings.push('템포 지시를 찾지 못해 ♩=100으로 설정했습니다');

  // 연속 동일 상태를 구간으로 그룹핑
  const sections: TempoSection[] = [];
  let secStart = 1;
  for (let i = 1; i <= perMeasure.length; i++) {
    const prev = perMeasure[i - 1]!;
    const next = perMeasure[i];
    const boundary = !next || next.num !== prev.num || next.denom !== prev.denom || next.bpm !== prev.bpm;
    if (boundary) {
      sections.push({
        id: `s${sections.length + 1}`,
        startMeasure: secStart,
        endMeasure: i,
        timeSignature: { num: prev.num, denom: prev.denom },
        bpm: prev.bpm,
        beatUnit: beatUnitFor(prev.num, prev.denom),
      });
      secStart = i + 1;
    }
  }

  const jumps: JumpDirective[] = repeats.map((r) => ({
    type: 'repeat',
    startMeasure: r.startMeasure,
    endMeasure: r.endMeasure,
    times: r.times,
    endings: r.endings.length > 0 ? r.endings : undefined,
  }));

  return { totalMeasures: measures.length, sections, jumps, title, warnings };
}

/** 파싱 결과 → 편집 가능한 템포맵 초안 */
export function toTempoMapDraft(result: MusicXmlResult, id: string): TempoMap {
  return {
    id,
    title: result.title,
    revision: 0,
    totalMeasures: result.totalMeasures,
    sections: result.sections,
    jumps: result.jumps,
    countIn: { measures: 1, useSectionMeter: true },
  };
}
