import type { MeasureTempoChange, TempoMap, TempoSection } from './types.js';

export interface CompiledMeasureTempo {
  measure: number;
  endMeasure: number;
  type: MeasureTempoChange['type'];
  startBpm: number;
  targetBpm: number;
  startBeat: number;
  totalBeats: number;
}

export interface MeasureTempoTiming {
  type: MeasureTempoChange['type'];
  startBpm: number;
  targetBpm: number;
  totalBeats: number;
  beatOffset: number;
}

/** Compile score-position tempo instructions without expanding repeats or mutating sections. */
export function compileMeasureTempos(
  map: TempoMap,
  beatCountFor: (section: TempoSection) => number,
) {
  const counts = map.sections.map((section) => Math.round(beatCountFor(section)));
  const prefixes: number[] = [];
  let total = 0;
  map.sections.forEach((section, index) => {
    prefixes.push(total);
    total += (section.endMeasure - section.startMeasure + 1) * counts[index]!;
    if (section.startMeasure === 1 && map.anacrusis) total -= counts[index]! - map.anacrusis.beats;
  });

  const sectionIndex = (measure: number): number => {
    let low = 0;
    let high = map.sections.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const section = map.sections[mid]!;
      if (measure < section.startMeasure) high = mid - 1;
      else if (measure > section.endMeasure) low = mid + 1;
      else return mid;
    }
    throw new RangeError(`No section covers measure ${measure}`);
  };

  const beatsBefore = (measure: number): number => {
    if (measure === map.totalMeasures + 1) return total;
    const index = sectionIndex(measure);
    const section = map.sections[index]!;
    let offset = (measure - section.startMeasure) * counts[index]!;
    if (section.startMeasure === 1 && measure > 1 && map.anacrusis) {
      offset -= counts[index]! - map.anacrusis.beats;
    }
    return prefixes[index]! + offset;
  };

  const baselineAt = (measure: number): number => {
    const index = sectionIndex(measure);
    const section = map.sections[index]!;
    if (section.tempoChange?.type === 'aTempo') return section.tempoChange.targetBpm;
    const span = beatsBefore(section.endMeasure + 1) - prefixes[index]!;
    const offset = beatsBefore(measure) - prefixes[index]!;
    return (
      section.bpm +
      (((section.tempoChange?.targetBpm ?? section.bpm) - section.bpm) * offset) / span
    );
  };

  const changes: CompiledMeasureTempo[] = [];
  const expressions = [...(map.measureExpressions ?? [])].sort((a, b) => a.measure - b.measure);
  for (const expression of expressions) {
    const change = expression.tempoChange;
    if (!change) continue;
    const previous = changes.at(-1);
    const section = map.sections[sectionIndex(expression.measure)]!;
    const startBpm =
      previous && section.startMeasure <= previous.endMeasure
        ? previous.targetBpm
        : baselineAt(expression.measure);
    const endMeasure =
      change.type === 'aTempo' ? expression.measure : (change.endMeasure ?? expression.measure);
    const startBeat = beatsBefore(expression.measure);
    changes.push({
      measure: expression.measure,
      endMeasure,
      type: change.type,
      startBpm,
      targetBpm: change.targetBpm,
      startBeat,
      totalBeats: beatsBefore(endMeasure + 1) - startBeat,
    });
  }

  const timingAt = (measure: number): MeasureTempoTiming | undefined => {
    let low = 0;
    let high = changes.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (changes[mid]!.measure <= measure) low = mid + 1;
      else high = mid - 1;
    }
    const change = changes[high];
    if (!change) return undefined;
    if (measure <= change.endMeasure) {
      return { ...change, beatOffset: beatsBefore(measure) - change.startBeat };
    }
    if (map.sections[sectionIndex(measure)]!.startMeasure > change.endMeasure) return undefined;
    return {
      type: 'aTempo',
      startBpm: change.targetBpm,
      targetBpm: change.targetBpm,
      totalBeats: 1,
      beatOffset: 0,
    };
  };

  const bpmAt = (measure: number): number => {
    const timing = timingAt(measure);
    if (!timing) return baselineAt(measure);
    if (timing.type === 'aTempo') return timing.targetBpm;
    return (
      timing.startBpm +
      ((timing.targetBpm - timing.startBpm) * timing.beatOffset) / timing.totalBeats
    );
  };
  return { changes, timingAt, bpmAt };
}
