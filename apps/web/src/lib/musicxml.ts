import type { TempoMap, TempoSection } from '@feelmyrythm/core';
import { unzipSync } from 'fflate';

const text = (element: Element | null, selector: string): string | null =>
  element?.querySelector(selector)?.textContent?.trim() ?? null;

const optionalNumber = (value: string | null): number =>
  value === null || value === '' ? Number.NaN : Number(value);

function decodeMusicXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const container = files['META-INF/container.xml'];
  let target = Object.keys(files).find(
    (name) => name.endsWith('.musicxml') || name.endsWith('.xml'),
  );
  if (container) {
    const containerXml = new DOMParser().parseFromString(
      new TextDecoder().decode(container),
      'application/xml',
    );
    target = containerXml.querySelector('rootfile')?.getAttribute('full-path') ?? target;
  }
  if (!target || !files[target]) throw new Error('MXL에 MusicXML 악보가 없습니다.');
  return new TextDecoder().decode(files[target]);
}

export async function readMusicXml(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith('.mxl')) {
    return decodeMusicXml(new Uint8Array(await file.arrayBuffer()));
  }
  return file.text();
}

export function musicXmlToTempoMap(xml: string, title = 'MusicXML'): TempoMap {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('MusicXML 문법을 확인해 주세요.');
  const part = document.querySelector('part');
  const measures = [...(part?.querySelectorAll(':scope > measure') ?? [])];
  if (measures.length === 0) throw new Error('MusicXML에서 마디를 찾지 못했습니다.');

  const sections: TempoSection[] = [];
  let currentNum = 4;
  let currentDenom = 4;
  let currentBpm = 120;
  let currentStart = 1;

  const flush = (endMeasure: number) => {
    if (endMeasure < currentStart) return;
    sections.push({
      id: crypto.randomUUID(),
      label: sections.length === 0 ? title : `Section ${sections.length + 1}`,
      startMeasure: currentStart,
      endMeasure,
      timeSignature: { num: currentNum, denom: currentDenom },
      bpm: currentBpm,
      beatUnit: currentDenom === 8 && currentNum % 3 === 0 ? 'dottedQuarter' : 'quarter',
      accentPattern: Array.from(
        { length: currentDenom === 8 && currentNum % 3 === 0 ? currentNum / 3 : currentNum },
        (_, index) => (index === 0 ? 2 : 1),
      ),
      subdivision: 1,
    });
  };

  measures.forEach((measure, index) => {
    const nextNum = Number(text(measure, 'attributes time beats') ?? currentNum);
    const nextDenom = Number(text(measure, 'attributes time beat-type') ?? currentDenom);
    const metronomeBpm = optionalNumber(text(measure, 'direction metronome per-minute'));
    const soundBpm = optionalNumber(
      measure.querySelector('sound[tempo]')?.getAttribute('tempo') ?? null,
    );
    const nextBpm = Number.isFinite(soundBpm)
      ? soundBpm
      : Number.isFinite(metronomeBpm)
        ? metronomeBpm
        : currentBpm;
    if (
      index > 0 &&
      (nextNum !== currentNum || nextDenom !== currentDenom || nextBpm !== currentBpm)
    ) {
      flush(index);
      currentStart = index + 1;
    }
    currentNum = nextNum;
    currentDenom = nextDenom;
    currentBpm = nextBpm;
  });
  flush(measures.length);

  const jumps: TempoMap['jumps'] = [];
  let repeatStart = 1;
  measures.forEach((measure, index) => {
    const number = index + 1;
    const forward = measure.querySelector('barline repeat[direction="forward"]');
    if (forward) repeatStart = number;
    const backward = measure.querySelector('barline repeat[direction="backward"]');
    if (backward) {
      const times = Number(backward.getAttribute('times') ?? 2);
      jumps.push({ type: 'repeat', startMeasure: repeatStart, endMeasure: number, times });
    }
  });

  const firstMeasure = measures[0];
  const implicit = firstMeasure?.getAttribute('implicit') === 'yes';

  return {
    id: crypto.randomUUID(),
    repertoireItemId: 'local',
    revision: 1,
    totalMeasures: measures.length,
    ...(implicit ? { anacrusis: { beats: 1 } } : {}),
    sections,
    jumps,
    countIn: { measures: 1, useSectionMeter: true },
  };
}

export async function renderMusicXml(container: HTMLElement, xml: string): Promise<void> {
  container.replaceChildren();
  const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
  const renderer = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: 'svg',
    drawingParameters: 'compacttight',
  });
  await renderer.load(xml);
  renderer.render();
}
