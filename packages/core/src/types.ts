/** A note duration expressed as a multiple of a quarter note. */
export type NoteValue =
  | 'whole'
  | 'dottedWhole'
  | 'half'
  | 'dottedHalf'
  | 'quarter'
  | 'dottedQuarter'
  | 'eighth'
  | 'dottedEighth'
  | 'sixteenth'
  | 'dottedSixteenth'
  | 'thirtySecond';

export type Accent = 0 | 1 | 2;

export interface TimeSignature {
  num: number;
  denom: number;
}

/**
 * A pickup measure. `beats` is measured in the beat unit of the section that
 * contains measure 1 and occupies the final beats of that nominal measure.
 */
export interface Anacrusis {
  beats: number;
}

export interface TempoChange {
  type: 'rit' | 'accel';
  targetBpm: number;
}

export interface TempoSection {
  id: string;
  label?: string;
  /** One-based, inclusive. */
  startMeasure: number;
  /** One-based, inclusive. */
  endMeasure: number;
  timeSignature: TimeSignature;
  bpm: number;
  beatUnit: NoteValue;
  tempoChange?: TempoChange;
  accentPattern?: Accent[];
  subdivision?: 1 | 2 | 3 | 4;
}

export interface VoltaEnding {
  measures: [number, number];
  forPass: number[];
}

export interface RepeatDirective {
  type: 'repeat';
  startMeasure: number;
  endMeasure: number;
  /** Total number of passes, including the first pass. */
  times: number;
  endings?: VoltaEnding[];
}

export interface DaCapoDirective {
  type: 'dc';
  atMeasure: number;
  alFine?: number;
  alCoda?: boolean;
}

export interface DalSegnoDirective {
  type: 'ds';
  atMeasure: number;
  segnoMeasure: number;
  alFine?: number;
  alCoda?: boolean;
}

export interface CodaDirective {
  type: 'coda';
  toCodaMeasure: number;
  codaMeasure: number;
}

export type JumpDirective = RepeatDirective | DaCapoDirective | DalSegnoDirective | CodaDirective;

export interface CountInPolicy {
  measures: 1 | 2;
  useSectionMeter: true;
}

export interface TempoMap {
  id: string;
  repertoireItemId: string;
  revision: number;
  totalMeasures: number;
  anacrusis?: Anacrusis;
  sections: TempoSection[];
  jumps: JumpDirective[];
  countIn: CountInPolicy;
}

/** A click event. `timeSec` is an absolute offset on its containing timeline. */
export interface Beat {
  timeSec: number;
  accent: Accent;
  isSubdivision: boolean;
  /** Zero-based primary beat index within the nominal measure. */
  beatIndex: number;
  /** Zero for a primary beat, otherwise the subdivision index. */
  subdivisionIndex: number;
}

export interface TimelineMeasure {
  measureNumber: number;
  /** Number of times this score measure has been visited so far. */
  pass: number;
  sectionId: string;
  /** Absolute offset from performance timeline t=0. */
  startTimeSec: number;
  beats: Beat[];
}

export interface PerformanceTimeline {
  tempoMapRevision: number;
  entries: TimelineMeasure[];
  totalDurationSec: number;
}

export interface LocateResult {
  entryIndex: number;
  /** Index into `entries[entryIndex].beats`, including subdivisions. */
  beatIndex: number;
}

export interface ExpandTimelineOptions {
  /** Hard guard for repeat/navigation expansion. Defaults to 100,000. */
  maxEntries?: number;
}

export type TempoMapValidationCode =
  | 'required'
  | 'range'
  | 'integer'
  | 'order'
  | 'coverage'
  | 'duplicate'
  | 'meter'
  | 'tempo'
  | 'accent'
  | 'jump'
  | 'ambiguous';

export interface TempoMapValidationIssue {
  code: TempoMapValidationCode;
  path: string;
  message: string;
}

export interface TempoMapValidationResult {
  valid: boolean;
  issues: TempoMapValidationIssue[];
}
