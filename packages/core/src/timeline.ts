import { TimelineExpansionError } from './errors.js';
import type {
  Accent,
  Beat,
  CodaDirective,
  DaCapoDirective,
  DalSegnoDirective,
  ExpandTimelineOptions,
  LocateResult,
  PerformanceTimeline,
  RepeatDirective,
  TempoMap,
  TempoSection,
  TimelineMeasure,
} from './types.js';
import { assertValidTempoMap, beatsPerMeasure } from './validation.js';

const DEFAULT_MAX_ENTRIES = 100_000;
const TIME_EPSILON_SEC = 1e-9;

interface RepeatPassContext {
  repeat: RepeatDirective;
  pass: number;
}

interface MeasureTiming {
  beatOffset: number;
  beatCount: number;
  nominalBeatStart: number;
}

interface SectionTiming {
  section: TempoSection;
  totalBeats: number;
  measures: Map<number, MeasureTiming>;
}

type NavigationDirective = DaCapoDirective | DalSegnoDirective;

interface NavigationPoint {
  directive: NavigationDirective;
  triggerIndex: number;
  order: number;
}

function isStrictlyInside(inner: RepeatDirective, outer: RepeatDirective): boolean {
  return (
    inner.startMeasure >= outer.startMeasure &&
    inner.endMeasure <= outer.endMeasure &&
    (inner.startMeasure !== outer.startMeasure || inner.endMeasure !== outer.endMeasure)
  );
}

function directRepeatsInRange(
  repeats: readonly RepeatDirective[],
  startMeasure: number,
  endMeasure: number,
  container?: RepeatDirective,
): RepeatDirective[] {
  const candidates = repeats.filter(
    (repeat) =>
      repeat !== container &&
      repeat.startMeasure >= startMeasure &&
      repeat.endMeasure <= endMeasure,
  );

  return candidates
    .filter(
      (candidate) =>
        !candidates.some((other) => other !== candidate && isStrictlyInside(candidate, other)),
    )
    .sort((left, right) => left.startMeasure - right.startMeasure);
}

function isIncludedByVoltas(measure: number, contexts: readonly RepeatPassContext[]): boolean {
  return contexts.every(({ repeat, pass }) => {
    const coveringEndings = (repeat.endings ?? []).filter(
      (ending) => ending.measures[0] <= measure && measure <= ending.measures[1],
    );
    return (
      coveringEndings.length === 0 ||
      coveringEndings.some((ending) => ending.forPass.includes(pass))
    );
  });
}

function buildRepeatRoute(map: TempoMap, maxEntries: number): number[] {
  const repeats = map.jumps.filter((jump): jump is RepeatDirective => jump.type === 'repeat');
  const route: number[] = [];

  const append = (measure: number): void => {
    if (route.length >= maxEntries) {
      throw new TimelineExpansionError(
        `Timeline expansion exceeded maxEntries (${String(maxEntries)}) while applying repeats`,
      );
    }
    route.push(measure);
  };

  const expandSpan = (
    startMeasure: number,
    endMeasure: number,
    contexts: readonly RepeatPassContext[],
    container?: RepeatDirective,
  ): void => {
    const directRepeats = directRepeatsInRange(repeats, startMeasure, endMeasure, container);
    let childIndex = 0;
    let measure = startMeasure;

    while (measure <= endMeasure) {
      const child = directRepeats[childIndex];
      if (child !== undefined && child.startMeasure === measure) {
        for (let pass = 1; pass <= child.times; pass += 1) {
          expandSpan(
            child.startMeasure,
            child.endMeasure,
            [...contexts, { repeat: child, pass }],
            child,
          );
        }
        measure = child.endMeasure + 1;
        childIndex += 1;
        continue;
      }

      if (isIncludedByVoltas(measure, contexts)) append(measure);
      measure += 1;
    }
  };

  expandSpan(1, map.totalMeasures, []);
  return route;
}

function firstIndexOfMeasure(route: readonly number[], measure: number): number {
  return route.findIndex((candidate) => candidate === measure);
}

function lastIndexOfMeasure(route: readonly number[], measure: number): number {
  for (let index = route.length - 1; index >= 0; index -= 1) {
    if (route[index] === measure) return index;
  }
  return -1;
}

function applyNavigation(
  map: TempoMap,
  repeatRoute: readonly number[],
  maxEntries: number,
): number[] {
  const navigationPoints: NavigationPoint[] = map.jumps
    .map((directive, order): NavigationPoint | undefined => {
      if (directive.type !== 'dc' && directive.type !== 'ds') return undefined;
      const triggerIndex = lastIndexOfMeasure(repeatRoute, directive.atMeasure);
      if (triggerIndex < 0) {
        throw new TimelineExpansionError(
          `${directive.type.toUpperCase()} measure ${String(directive.atMeasure)} is absent after volta expansion`,
        );
      }
      return { directive, triggerIndex, order };
    })
    .filter((point): point is NavigationPoint => point !== undefined)
    .sort((left, right) => left.order - right.order);

  const coda = map.jumps.find((directive): directive is CodaDirective => directive.type === 'coda');
  const executedNavigation = new Set<number>();
  let activeFine: number | undefined;
  let codaArmed = false;
  let codaUsed = false;
  let routeIndex = 0;
  const result: number[] = [];

  while (routeIndex < repeatRoute.length) {
    if (result.length >= maxEntries) {
      throw new TimelineExpansionError(
        `Timeline expansion exceeded maxEntries (${String(maxEntries)}) while applying navigation jumps`,
      );
    }

    const measure = repeatRoute[routeIndex];
    if (measure === undefined) break;
    result.push(measure);

    if (activeFine === measure) break;

    if (codaArmed && !codaUsed && coda !== undefined && measure === coda.toCodaMeasure) {
      let codaIndex = repeatRoute.findIndex(
        (candidate, index) => index > routeIndex && candidate === coda.codaMeasure,
      );
      if (codaIndex < 0) codaIndex = firstIndexOfMeasure(repeatRoute, coda.codaMeasure);
      if (codaIndex < 0) {
        throw new TimelineExpansionError(
          `Coda measure ${String(coda.codaMeasure)} is absent after volta expansion`,
        );
      }
      codaUsed = true;
      routeIndex = codaIndex;
      continue;
    }

    const navigation = navigationPoints.find(
      (point) => point.triggerIndex === routeIndex && !executedNavigation.has(point.order),
    );
    if (navigation !== undefined) {
      executedNavigation.add(navigation.order);
      activeFine = navigation.directive.alFine;
      codaArmed = navigation.directive.alCoda === true;

      if (navigation.directive.type === 'dc') {
        routeIndex = 0;
      } else {
        const segnoIndex = firstIndexOfMeasure(repeatRoute, navigation.directive.segnoMeasure);
        if (segnoIndex < 0) {
          throw new TimelineExpansionError(
            `Segno measure ${String(navigation.directive.segnoMeasure)} is absent after volta expansion`,
          );
        }
        routeIndex = segnoIndex;
      }
      continue;
    }

    routeIndex += 1;
  }

  return result;
}

function sectionForMeasure(map: TempoMap, measure: number): TempoSection {
  let low = 0;
  let high = map.sections.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const section = map.sections[middle];
    if (section === undefined) break;
    if (measure < section.startMeasure) high = middle - 1;
    else if (measure > section.endMeasure) low = middle + 1;
    else return section;
  }
  throw new TimelineExpansionError(`No tempo section covers measure ${String(measure)}`);
}

function createSectionTimings(map: TempoMap): Map<string, SectionTiming> {
  const timings = new Map<string, SectionTiming>();
  for (const section of map.sections) {
    const fullBeatCount = Math.round(beatsPerMeasure(section));
    const measures = new Map<number, MeasureTiming>();
    const anacrusisBeats = map.anacrusis?.beats;
    let beatOffset = 0;
    for (let measure = section.startMeasure; measure <= section.endMeasure; measure += 1) {
      const isPickup = measure === 1 && anacrusisBeats !== undefined;
      const beatCount = isPickup ? anacrusisBeats : fullBeatCount;
      const nominalBeatStart = isPickup ? fullBeatCount - beatCount : 0;
      measures.set(measure, { beatOffset, beatCount, nominalBeatStart });
      beatOffset += beatCount;
    }
    timings.set(section.id, { section, totalBeats: beatOffset, measures });
  }
  return timings;
}

function tempoAt(sectionTiming: SectionTiming, beatPosition: number): number {
  const { section, totalBeats } = sectionTiming;
  const targetBpm = section.tempoChange?.targetBpm ?? section.bpm;
  return section.bpm + ((targetBpm - section.bpm) * beatPosition) / totalBeats;
}

/** Integrates 60 / BPM over score-beat position for continuous linear BPM changes. */
function durationBetween(sectionTiming: SectionTiming, startBeat: number, endBeat: number): number {
  const { section, totalBeats } = sectionTiming;
  const targetBpm = section.tempoChange?.targetBpm ?? section.bpm;
  const slope = (targetBpm - section.bpm) / totalBeats;
  if (Math.abs(slope) < Number.EPSILON) return (60 * (endBeat - startBeat)) / section.bpm;

  const startBpm = section.bpm + slope * startBeat;
  const endBpm = section.bpm + slope * endBeat;
  return (60 / slope) * Math.log(endBpm / startBpm);
}

function accentPattern(section: TempoSection, fullBeatCount: number): Accent[] {
  if (section.accentPattern !== undefined) return section.accentPattern;
  return Array.from({ length: fullBeatCount }, (_, index): Accent => (index === 0 ? 2 : 0));
}

function createTimelineMeasure(
  map: TempoMap,
  measureNumber: number,
  pass: number,
  startTimeSec: number,
  sectionTimings: ReadonlyMap<string, SectionTiming>,
): { entry: TimelineMeasure; durationSec: number } {
  const section = sectionForMeasure(map, measureNumber);
  const sectionTiming = sectionTimings.get(section.id);
  const measureTiming = sectionTiming?.measures.get(measureNumber);
  if (sectionTiming === undefined || measureTiming === undefined) {
    throw new TimelineExpansionError(`Missing timing data for measure ${String(measureNumber)}`);
  }

  const fullBeatCount = Math.round(beatsPerMeasure(section));
  const accents = accentPattern(section, fullBeatCount);
  const subdivision = section.subdivision ?? 1;
  const beats: Beat[] = [];

  for (let localBeat = 0; localBeat < measureTiming.beatCount; localBeat += 1) {
    const nominalBeat = measureTiming.nominalBeatStart + localBeat;
    const scoreBeat = measureTiming.beatOffset + localBeat;
    for (let sub = 0; sub < subdivision; sub += 1) {
      const fraction = sub / subdivision;
      beats.push({
        timeSec:
          startTimeSec +
          durationBetween(sectionTiming, measureTiming.beatOffset, scoreBeat + fraction),
        accent: sub === 0 ? (accents[nominalBeat] ?? 0) : 0,
        isSubdivision: sub !== 0,
        beatIndex: nominalBeat,
        subdivisionIndex: sub,
      });
    }
  }

  const durationSec = durationBetween(
    sectionTiming,
    measureTiming.beatOffset,
    measureTiming.beatOffset + measureTiming.beatCount,
  );
  return {
    entry: { measureNumber, pass, sectionId: section.id, startTimeSec, beats },
    durationSec,
  };
}

export function expandTimeline(
  map: TempoMap,
  options: ExpandTimelineOptions = {},
): PerformanceTimeline {
  assertValidTempoMap(map);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError('maxEntries must be a positive integer');
  }

  const repeatRoute = buildRepeatRoute(map, maxEntries);
  const route = applyNavigation(map, repeatRoute, maxEntries);
  if (route.length === 0) {
    throw new TimelineExpansionError('TempoMap expands to an empty performance timeline');
  }

  const sectionTimings = createSectionTimings(map);
  const passes = new Map<number, number>();
  const entries: TimelineMeasure[] = [];
  let timelineTime = 0;

  for (const measureNumber of route) {
    const pass = (passes.get(measureNumber) ?? 0) + 1;
    passes.set(measureNumber, pass);
    const { entry, durationSec } = createTimelineMeasure(
      map,
      measureNumber,
      pass,
      timelineTime,
      sectionTimings,
    );
    entries.push(entry);
    timelineTime += durationSec;
  }

  return {
    tempoMapRevision: map.revision,
    entries,
    totalDurationSec: timelineTime,
  };
}

export function locate(timeline: PerformanceTimeline, elapsedSec: number): LocateResult {
  if (!Number.isFinite(elapsedSec)) throw new RangeError('elapsedSec must be finite');
  if (timeline.entries.length === 0) throw new RangeError('timeline must contain an entry');

  const boundedTime = Math.min(Math.max(elapsedSec, 0), timeline.totalDurationSec);
  let low = 0;
  let high = timeline.entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = timeline.entries[middle];
    if (entry !== undefined && entry.startTimeSec <= boundedTime) low = middle + 1;
    else high = middle - 1;
  }
  const entryIndex = Math.max(0, high);
  const entry = timeline.entries[entryIndex];
  if (entry === undefined || entry.beats.length === 0) {
    throw new RangeError('timeline entry must contain at least one beat');
  }

  low = 0;
  high = entry.beats.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const beat = entry.beats[middle];
    if (beat !== undefined && beat.timeSec <= boundedTime) low = middle + 1;
    else high = middle - 1;
  }
  return { entryIndex, beatIndex: Math.max(0, high) };
}

export function seekPoint(timeline: PerformanceTimeline, measure: number, pass?: number): number {
  if (!Number.isInteger(measure) || measure <= 0) {
    throw new RangeError('measure must be a positive integer');
  }
  if (pass !== undefined && (!Number.isInteger(pass) || pass <= 0)) {
    throw new RangeError('pass must be a positive integer');
  }
  const entry = timeline.entries.find(
    (candidate) =>
      candidate.measureNumber === measure && (pass === undefined || candidate.pass === pass),
  );
  if (entry === undefined) {
    throw new RangeError(
      `Measure ${String(measure)}${pass === undefined ? '' : ` pass ${String(pass)}`} is not in the timeline`,
    );
  }
  return entry.startTimeSec;
}

export function buildCountIn(map: TempoMap, fromTimeSec: number): Beat[] {
  assertValidTempoMap(map);
  if (!Number.isFinite(fromTimeSec)) throw new RangeError('fromTimeSec must be finite');
  const timeline = expandTimeline(map);
  const anchor = timeline.entries.find(
    (entry) => Math.abs(entry.startTimeSec - fromTimeSec) <= TIME_EPSILON_SEC,
  );
  if (anchor === undefined) {
    throw new RangeError('fromTimeSec must be an exact value returned by seekPoint');
  }

  const section = sectionForMeasure(map, anchor.measureNumber);
  const sectionTiming = createSectionTimings(map).get(section.id);
  const measureTiming = sectionTiming?.measures.get(anchor.measureNumber);
  if (sectionTiming === undefined || measureTiming === undefined) {
    throw new TimelineExpansionError('Unable to derive count-in tempo');
  }

  const fullBeatCount = Math.round(beatsPerMeasure(section));
  const bpm = tempoAt(sectionTiming, measureTiming.beatOffset);
  const beatDurationSec = 60 / bpm;
  const count = map.countIn.measures * fullBeatCount;
  const startTimeSec = fromTimeSec - count * beatDurationSec;
  const accents = accentPattern(section, fullBeatCount);

  return Array.from({ length: count }, (_, index): Beat => {
    const beatIndex = index % fullBeatCount;
    return {
      timeSec: startTimeSec + index * beatDurationSec,
      accent: accents[beatIndex] ?? 0,
      isSubdivision: false,
      beatIndex,
      subdivisionIndex: 0,
    };
  });
}
