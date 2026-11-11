import type { TempoMap, TempoSection } from '@feelmyrythm/core';
import { unzip, unzipSync, type UnzipFileInfo } from 'fflate';

const MAX_MUSIC_XML_BYTES = 50 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 64 * 1024;
const MAX_ARCHIVE_ENTRIES = 2048;

const text = (element: Element | null, selector: string): string | null =>
  element?.querySelector(selector)?.textContent?.trim() ?? null;

const optionalNumber = (value: string | null): number =>
  value === null || value === '' ? Number.NaN : Number(value);

async function decodeMusicXml(bytes: Uint8Array): Promise<string> {
  const entries = new Map<string, UnzipFileInfo>();
  // Inspect the central directory without inflating images, audio or other scores.
  unzipSync(bytes, {
    filter(entry) {
      if (entries.size >= MAX_ARCHIVE_ENTRIES || entries.has(entry.name)) {
        throw new Error('MXL 항목이 너무 많거나 파일 이름이 중복됩니다.');
      }
      entries.set(entry.name, entry);
      return false;
    },
  });
  const extract = (name: string, limit: number): Promise<string> => {
    const entry = entries.get(name);
    if (!entry) throw new Error('MXL에 지정된 MusicXML 파일이 없습니다.');
    if (entry.originalSize > limit) throw new Error('MXL 압축 해제 크기 제한을 초과했습니다.');
    return new Promise((resolve, reject) => {
      unzip(bytes, { filter: (file) => file.name === name }, (error, files) => {
        if (error) reject(error);
        else resolve(new TextDecoder().decode(files[name]));
      });
    });
  };
  let target = [...entries.keys()].find(
    (name) => !/^META-INF\//i.test(name) && /\.(musicxml|xml)$/i.test(name),
  );
  if (entries.has('META-INF/container.xml')) {
    const containerXml = new DOMParser().parseFromString(
      await extract('META-INF/container.xml', MAX_CONTAINER_BYTES),
      'application/xml',
    );
    if (containerXml.querySelector('parsererror')) {
      throw new Error('MXL container.xml 문법을 확인해 주세요.');
    }
    target = containerXml.querySelector('rootfile')?.getAttribute('full-path') ?? target;
  }
  if (!target || /^META-INF\//i.test(target)) throw new Error('MXL에 MusicXML 악보가 없습니다.');
  return extract(target, MAX_MUSIC_XML_BYTES);
}

export async function readMusicXml(file: File): Promise<string> {
  if (file.size > MAX_MUSIC_XML_BYTES) throw new Error('MusicXML 파일은 50 MiB 이하여야 합니다.');
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

export async function renderMusicXml(
  container: HTMLElement,
  xml: string,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<void> {
  const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
  if (signal.aborted) return;
  const surface = document.createElement('div');
  container.replaceChildren(surface);
  const renderer = new OpenSheetMusicDisplay(surface, {
    // OSMD 2.1.2 has no dispose(): its window resize listener cannot be removed.
    autoResize: false,
    backend: 'svg',
    drawingParameters: 'compacttight',
  });
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  const cleanup = () => {
    signal.removeEventListener('abort', cleanup);
    observer?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    renderer.clear();
    surface.remove();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    await renderer.load(xml);
    if (signal.aborted) {
      // load() may finish after cleanup and repopulate the instance's sheet.
      renderer.clear();
      return;
    }
    renderer.render();
    let width = container.clientWidth;
    observer = new ResizeObserver(() => {
      if (signal.aborted || container.clientWidth === width) return;
      width = container.clientWidth;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (signal.aborted) return;
        try {
          renderer.render();
        } catch (error) {
          cleanup();
          onError(error);
        }
      });
    });
    observer.observe(container);
  } catch (error) {
    cleanup();
    throw error;
  }
}
