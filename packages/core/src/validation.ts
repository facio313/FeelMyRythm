import { TempoMapValidationError } from './errors.js';
import { compileMeasureTempos } from './measure-tempo.js';
import type {
  NoteValue,
  RepeatDirective,
  TempoMap,
  TempoMapValidationIssue,
  TempoMapValidationResult,
  TempoSection,
} from './types.js';

const NOTE_VALUE_QUARTER_LENGTHS: Readonly<Record<NoteValue, number>> = {
  whole: 4,
  dottedWhole: 6,
  half: 2,
  dottedHalf: 3,
  quarter: 1,
  dottedQuarter: 1.5,
  eighth: 0.5,
  dottedEighth: 0.75,
  sixteenth: 0.25,
  dottedSixteenth: 0.375,
  thirtySecond: 0.125,
};

const EPSILON = 1e-9;
const NOTE_VALUES = new Set<string>(Object.keys(NOTE_VALUE_QUARTER_LENGTHS));

export function noteValueInQuarterNotes(noteValue: NoteValue): number {
  return NOTE_VALUE_QUARTER_LENGTHS[noteValue];
}

export function beatsPerMeasure(section: TempoSection): number {
  const quarterNotesPerMeasure = section.timeSignature.num * (4 / section.timeSignature.denom);
  return quarterNotesPerMeasure / noteValueInQuarterNotes(section.beatUnit);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isMeasure(value: number, totalMeasures: number): boolean {
  return isPositiveInteger(value) && value <= totalMeasures;
}

function addIssue(
  issues: TempoMapValidationIssue[],
  code: TempoMapValidationIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  issues: TempoMapValidationIssue[],
): void {
  if (typeof record[key] !== 'string') {
    addIssue(issues, 'required', path, 'must be a string');
  }
}

function requireNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  issues: TempoMapValidationIssue[],
): void {
  if (typeof record[key] !== 'number') {
    addIssue(issues, 'required', path, 'must be a number');
  }
}

function validateExpressionStructure(
  record: Readonly<Record<string, unknown>>,
  path: string,
  issues: TempoMapValidationIssue[],
  measureLevel: boolean,
): void {
  if (record.tempoChange !== undefined) {
    if (!isRecord(record.tempoChange)) {
      addIssue(issues, 'required', `${path}.tempoChange`, 'must be an object');
    } else {
      if (
        record.tempoChange.type !== 'rit' &&
        record.tempoChange.type !== 'accel' &&
        record.tempoChange.type !== 'aTempo'
      ) {
        addIssue(issues, 'tempo', `${path}.tempoChange.type`, 'must be rit, accel or aTempo');
      }
      requireNumber(record.tempoChange, 'targetBpm', `${path}.tempoChange.targetBpm`, issues);
    }
  }

  if (record.fermata !== undefined) {
    if (!isRecord(record.fermata)) {
      addIssue(issues, 'required', `${path}.fermata`, 'must be an object');
    } else {
      requireNumber(record.fermata, 'extraBeats', `${path}.fermata.extraBeats`, issues);
    }
  }
  if (record.breath !== undefined) {
    if (!isRecord(record.breath)) {
      addIssue(issues, 'required', `${path}.breath`, 'must be an object');
    } else {
      requireNumber(record.breath, 'durationSec', `${path}.breath.durationSec`, issues);
      if (typeof record.breath.countIn !== 'boolean') {
        addIssue(issues, 'required', `${path}.breath.countIn`, 'must be a boolean');
      }
    }
  }
  if (measureLevel && isRecord(record.tempoChange) && record.tempoChange.endMeasure !== undefined) {
    requireNumber(record.tempoChange, 'endMeasure', `${path}.tempoChange.endMeasure`, issues);
  }
  if (isRecord(record.fermata) && record.fermata.beat !== undefined) {
    requireNumber(record.fermata, 'beat', `${path}.fermata.beat`, issues);
  }
}

function validateTempoMapStructure(input: unknown): TempoMapValidationIssue[] {
  const issues: TempoMapValidationIssue[] = [];
  if (!isRecord(input)) {
    addIssue(issues, 'required', '$', 'must be an object');
    return issues;
  }

  requireString(input, 'id', 'id', issues);
  requireString(input, 'repertoireItemId', 'repertoireItemId', issues);
  requireNumber(input, 'revision', 'revision', issues);
  requireNumber(input, 'totalMeasures', 'totalMeasures', issues);

  if (input.anacrusis !== undefined) {
    if (!isRecord(input.anacrusis)) {
      addIssue(issues, 'required', 'anacrusis', 'must be an object');
    } else {
      requireNumber(input.anacrusis, 'beats', 'anacrusis.beats', issues);
    }
  }

  if (!Array.isArray(input.sections)) {
    addIssue(issues, 'required', 'sections', 'must be an array');
  } else {
    input.sections.forEach((rawSection, index) => {
      const path = `sections[${index}]`;
      if (!isRecord(rawSection)) {
        addIssue(issues, 'required', path, 'must be an object');
        return;
      }
      requireString(rawSection, 'id', `${path}.id`, issues);
      if (rawSection.label !== undefined && typeof rawSection.label !== 'string') {
        addIssue(issues, 'required', `${path}.label`, 'must be a string');
      }
      requireNumber(rawSection, 'startMeasure', `${path}.startMeasure`, issues);
      requireNumber(rawSection, 'endMeasure', `${path}.endMeasure`, issues);
      requireNumber(rawSection, 'bpm', `${path}.bpm`, issues);
      requireString(rawSection, 'beatUnit', `${path}.beatUnit`, issues);
      if (typeof rawSection.beatUnit === 'string' && !NOTE_VALUES.has(rawSection.beatUnit)) {
        addIssue(issues, 'meter', `${path}.beatUnit`, 'is not a supported note value');
      }

      if (!isRecord(rawSection.timeSignature)) {
        addIssue(issues, 'required', `${path}.timeSignature`, 'must be an object');
      } else {
        requireNumber(rawSection.timeSignature, 'num', `${path}.timeSignature.num`, issues);
        requireNumber(rawSection.timeSignature, 'denom', `${path}.timeSignature.denom`, issues);
      }

      validateExpressionStructure(rawSection, path, issues, false);

      if (rawSection.accentPattern !== undefined) {
        if (!Array.isArray(rawSection.accentPattern)) {
          addIssue(issues, 'required', `${path}.accentPattern`, 'must be an array');
        } else {
          rawSection.accentPattern.forEach((accent, accentIndex) => {
            if (typeof accent !== 'number') {
              addIssue(
                issues,
                'accent',
                `${path}.accentPattern[${accentIndex}]`,
                'must be a number',
              );
            }
          });
        }
      }
      if (rawSection.subdivision !== undefined && typeof rawSection.subdivision !== 'number') {
        addIssue(issues, 'required', `${path}.subdivision`, 'must be a number');
      }
    });
  }

  if (input.measureExpressions !== undefined) {
    if (!Array.isArray(input.measureExpressions)) {
      addIssue(issues, 'required', 'measureExpressions', 'must be an array');
    } else {
      input.measureExpressions.forEach((record, index) => {
        const path = `measureExpressions[${index}]`;
        if (!isRecord(record)) {
          addIssue(issues, 'required', path, 'must be an object');
          return;
        }
        requireNumber(record, 'measure', `${path}.measure`, issues);
        validateExpressionStructure(record, path, issues, true);
      });
    }
  }

  if (!Array.isArray(input.jumps)) {
    addIssue(issues, 'required', 'jumps', 'must be an array');
  } else {
    input.jumps.forEach((rawJump, index) => {
      const path = `jumps[${index}]`;
      if (!isRecord(rawJump)) {
        addIssue(issues, 'required', path, 'must be an object');
        return;
      }
      if (
        rawJump.type !== 'repeat' &&
        rawJump.type !== 'dc' &&
        rawJump.type !== 'ds' &&
        rawJump.type !== 'coda'
      ) {
        addIssue(issues, 'jump', `${path}.type`, 'is not a supported jump type');
        return;
      }

      if (rawJump.type === 'repeat') {
        requireNumber(rawJump, 'startMeasure', `${path}.startMeasure`, issues);
        requireNumber(rawJump, 'endMeasure', `${path}.endMeasure`, issues);
        requireNumber(rawJump, 'times', `${path}.times`, issues);
        if (rawJump.endings !== undefined) {
          if (!Array.isArray(rawJump.endings)) {
            addIssue(issues, 'required', `${path}.endings`, 'must be an array');
          } else {
            rawJump.endings.forEach((rawEnding, endingIndex) => {
              const endingPath = `${path}.endings[${endingIndex}]`;
              if (!isRecord(rawEnding)) {
                addIssue(issues, 'required', endingPath, 'must be an object');
                return;
              }
              if (
                !Array.isArray(rawEnding.measures) ||
                rawEnding.measures.length !== 2 ||
                rawEnding.measures.some((measure) => typeof measure !== 'number')
              ) {
                addIssue(issues, 'jump', `${endingPath}.measures`, 'must be a two-number tuple');
              }
              if (
                !Array.isArray(rawEnding.forPass) ||
                rawEnding.forPass.some((pass) => typeof pass !== 'number')
              ) {
                addIssue(issues, 'jump', `${endingPath}.forPass`, 'must be a number array');
              }
            });
          }
        }
        return;
      }

      if (rawJump.type === 'dc' || rawJump.type === 'ds') {
        requireNumber(rawJump, 'atMeasure', `${path}.atMeasure`, issues);
        if (rawJump.type === 'ds') {
          requireNumber(rawJump, 'segnoMeasure', `${path}.segnoMeasure`, issues);
        }
        if (rawJump.alFine !== undefined && typeof rawJump.alFine !== 'number') {
          addIssue(issues, 'jump', `${path}.alFine`, 'must be a number');
        }
        if (rawJump.alCoda !== undefined && typeof rawJump.alCoda !== 'boolean') {
          addIssue(issues, 'jump', `${path}.alCoda`, 'must be a boolean');
        }
        return;
      }

      requireNumber(rawJump, 'toCodaMeasure', `${path}.toCodaMeasure`, issues);
      requireNumber(rawJump, 'codaMeasure', `${path}.codaMeasure`, issues);
    });
  }

  if (!isRecord(input.countIn)) {
    addIssue(issues, 'required', 'countIn', 'must be an object');
  } else {
    requireNumber(input.countIn, 'measures', 'countIn.measures', issues);
    if (typeof input.countIn.useSectionMeter !== 'boolean') {
      addIssue(issues, 'required', 'countIn.useSectionMeter', 'must be a boolean');
    }
  }

  return issues;
}

function validateHoldValues(
  record: Pick<TempoSection, 'fermata' | 'breath'>,
  path: string,
  issues: TempoMapValidationIssue[],
): void {
  if (record.fermata !== undefined) {
    const { extraBeats } = record.fermata;
    if (!isPositiveFinite(extraBeats) || extraBeats > 16) {
      addIssue(
        issues,
        'range',
        `${path}.fermata.extraBeats`,
        'must be finite, greater than zero and at most 16',
      );
    }
  }
  if (record.breath !== undefined) {
    const { durationSec } = record.breath;
    if (!isPositiveFinite(durationSec) || durationSec > 300) {
      addIssue(
        issues,
        'range',
        `${path}.breath.durationSec`,
        'must be finite, greater than zero and at most 300',
      );
    }
  }
}

function validateFermataBeat(
  fermata: NonNullable<TempoSection['fermata']>,
  measure: number,
  section: TempoSection,
  map: TempoMap,
  path: string,
  issues: TempoMapValidationIssue[],
): void {
  if (fermata.beat === undefined) return;
  const count = Math.round(beatsPerMeasure(section));
  const first = measure === 1 && map.anacrusis ? count - map.anacrusis.beats + 1 : 1;
  if (!Number.isInteger(fermata.beat) || fermata.beat < first || fermata.beat > count) {
    addIssue(
      issues,
      'range',
      `${path}.fermata.beat`,
      'must be a primary beat present in this measure',
    );
  }
}

function validateMeasureExpressions(map: TempoMap, issues: TempoMapValidationIssue[]): void {
  // Tempo resolution needs the previously validated section coverage and meter.
  if (issues.length) return;
  map.sections.forEach((section, index) => {
    if (section.fermata)
      validateFermataBeat(
        section.fermata,
        section.endMeasure,
        section,
        map,
        `sections[${index}]`,
        issues,
      );
  });
  const seen = new Set<number>();
  const indexed = (map.measureExpressions ?? []).map((expression, index) => ({
    expression,
    index,
  }));
  indexed.forEach(({ expression, index }) => {
    const path = `measureExpressions[${index}]`;
    validateHoldValues(expression, path, issues);
    if (!isMeasure(expression.measure, map.totalMeasures)) {
      addIssue(issues, 'range', `${path}.measure`, 'must be a measure in the map');
      return;
    }
    if (seen.has(expression.measure))
      addIssue(issues, 'duplicate', `${path}.measure`, 'must be unique');
    seen.add(expression.measure);
    let low = 0;
    let high = map.sections.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (map.sections[mid]!.endMeasure < expression.measure) low = mid + 1;
      else high = mid;
    }
    if (expression.fermata)
      validateFermataBeat(
        expression.fermata,
        expression.measure,
        map.sections[low]!,
        map,
        path,
        issues,
      );
    const change = expression.tempoChange;
    if (change) {
      if (!isPositiveFinite(change.targetBpm))
        addIssue(
          issues,
          'tempo',
          `${path}.tempoChange.targetBpm`,
          'must be finite and greater than zero',
        );
      if (
        change.endMeasure !== undefined &&
        (!isMeasure(change.endMeasure, map.totalMeasures) || change.endMeasure < expression.measure)
      ) {
        addIssue(
          issues,
          'range',
          `${path}.tempoChange.endMeasure`,
          'must be from the marked measure through totalMeasures',
        );
      }
      if (change.type === 'aTempo' && change.endMeasure !== undefined) {
        addIssue(
          issues,
          'tempo',
          `${path}.tempoChange.endMeasure`,
          'aTempo is immediate and must omit endMeasure',
        );
      }
    }
  });
  const changes = indexed
    .filter(({ expression }) => expression.tempoChange)
    .sort((a, b) => a.expression.measure - b.expression.measure);
  let previousEnd = 0;
  for (const { expression, index } of changes) {
    const change = expression.tempoChange!;
    if (expression.measure <= previousEnd)
      addIssue(
        issues,
        'ambiguous',
        `measureExpressions[${index}].tempoChange`,
        'tempo spans must not overlap',
      );
    previousEnd =
      change.type === 'aTempo' ? expression.measure : (change.endMeasure ?? expression.measure);
  }
  if (issues.length) return;
  const indices = new Map(indexed.map(({ expression, index }) => [expression.measure, index]));
  for (const change of compileMeasureTempos(map, beatsPerMeasure).changes) {
    if (
      (change.type === 'rit' && change.targetBpm >= change.startBpm) ||
      (change.type === 'accel' && change.targetBpm <= change.startBpm)
    ) {
      addIssue(
        issues,
        'tempo',
        `measureExpressions[${indices.get(change.measure)!}].tempoChange`,
        `${change.type} targetBpm must follow the effective starting tempo ${change.startBpm}`,
      );
    }
  }
}

function validateSection(
  section: TempoSection,
  index: number,
  totalMeasures: number,
  issues: TempoMapValidationIssue[],
): void {
  const path = `sections[${index}]`;

  if (section.id.trim().length === 0) {
    addIssue(issues, 'required', `${path}.id`, 'must not be empty');
  }
  if (!isMeasure(section.startMeasure, totalMeasures)) {
    addIssue(issues, 'range', `${path}.startMeasure`, 'must be a measure in the map');
  }
  if (!isMeasure(section.endMeasure, totalMeasures)) {
    addIssue(issues, 'range', `${path}.endMeasure`, 'must be a measure in the map');
  }
  if (section.endMeasure < section.startMeasure) {
    addIssue(issues, 'order', `${path}.endMeasure`, 'must not precede startMeasure');
  }

  const { num, denom } = section.timeSignature;
  if (!isPositiveInteger(num)) {
    addIssue(issues, 'meter', `${path}.timeSignature.num`, 'must be a positive integer');
  }
  if (!isPositiveInteger(denom) || (denom & (denom - 1)) !== 0) {
    addIssue(issues, 'meter', `${path}.timeSignature.denom`, 'must be a positive power of two');
  }
  if (!isPositiveFinite(section.bpm)) {
    addIssue(issues, 'tempo', `${path}.bpm`, 'must be finite and greater than zero');
  }

  const measureBeats = beatsPerMeasure(section);
  if (
    !isPositiveFinite(measureBeats) ||
    Math.abs(measureBeats - Math.round(measureBeats)) > EPSILON
  ) {
    addIssue(
      issues,
      'meter',
      `${path}.beatUnit`,
      'must divide the notated measure into a whole number of beats',
    );
  }

  if (section.tempoChange !== undefined) {
    const { targetBpm, type } = section.tempoChange;
    if (!isPositiveFinite(targetBpm)) {
      addIssue(
        issues,
        'tempo',
        `${path}.tempoChange.targetBpm`,
        'must be finite and greater than zero',
      );
    } else if (type === 'rit' && targetBpm >= section.bpm) {
      addIssue(issues, 'tempo', `${path}.tempoChange`, 'rit targetBpm must be lower than bpm');
    } else if (type === 'accel' && targetBpm <= section.bpm) {
      addIssue(issues, 'tempo', `${path}.tempoChange`, 'accel targetBpm must be higher than bpm');
    }
  }

  validateHoldValues(section, path, issues);

  if (section.accentPattern !== undefined) {
    if (
      Number.isInteger(measureBeats) &&
      section.accentPattern.length !== Math.round(measureBeats)
    ) {
      addIssue(
        issues,
        'accent',
        `${path}.accentPattern`,
        `must contain exactly ${String(Math.round(measureBeats))} accents`,
      );
    }
    section.accentPattern.forEach((accent, accentIndex) => {
      if (accent !== 0 && accent !== 1 && accent !== 2) {
        addIssue(issues, 'accent', `${path}.accentPattern[${accentIndex}]`, 'must be 0, 1, or 2');
      }
    });
  }

  if (
    section.subdivision !== undefined &&
    section.subdivision !== 1 &&
    section.subdivision !== 2 &&
    section.subdivision !== 3 &&
    section.subdivision !== 4
  ) {
    addIssue(issues, 'range', `${path}.subdivision`, 'must be 1, 2, 3, or 4');
  }
}

function validateRepeat(
  repeat: RepeatDirective,
  index: number,
  totalMeasures: number,
  issues: TempoMapValidationIssue[],
): void {
  const path = `jumps[${index}]`;
  if (!isMeasure(repeat.startMeasure, totalMeasures)) {
    addIssue(issues, 'jump', `${path}.startMeasure`, 'must be a measure in the map');
  }
  if (!isMeasure(repeat.endMeasure, totalMeasures)) {
    addIssue(issues, 'jump', `${path}.endMeasure`, 'must be a measure in the map');
  }
  if (repeat.endMeasure < repeat.startMeasure) {
    addIssue(issues, 'jump', `${path}.endMeasure`, 'must not precede startMeasure');
  }
  if (!isPositiveInteger(repeat.times)) {
    addIssue(issues, 'integer', `${path}.times`, 'must be a positive integer');
  }

  const endings = repeat.endings ?? [];
  endings.forEach((ending, endingIndex) => {
    const endingPath = `${path}.endings[${endingIndex}]`;
    const [start, end] = ending.measures;
    if (
      !isMeasure(start, totalMeasures) ||
      !isMeasure(end, totalMeasures) ||
      start < repeat.startMeasure ||
      end > repeat.endMeasure ||
      end < start
    ) {
      addIssue(
        issues,
        'jump',
        `${endingPath}.measures`,
        'must be an ordered range inside the repeat',
      );
    }
    if (ending.forPass.length === 0) {
      addIssue(issues, 'required', `${endingPath}.forPass`, 'must contain at least one pass');
    }
    const uniquePasses = new Set<number>();
    ending.forPass.forEach((pass, passIndex) => {
      if (!isPositiveInteger(pass) || pass > repeat.times) {
        addIssue(
          issues,
          'range',
          `${endingPath}.forPass[${passIndex}]`,
          'must identify an existing repeat pass',
        );
      }
      if (uniquePasses.has(pass)) {
        addIssue(
          issues,
          'duplicate',
          `${endingPath}.forPass[${passIndex}]`,
          'must not duplicate a pass',
        );
      }
      uniquePasses.add(pass);
    });
  });

  for (let left = 0; left < endings.length; left += 1) {
    const a = endings[left];
    if (a === undefined) continue;
    for (let right = left + 1; right < endings.length; right += 1) {
      const b = endings[right];
      if (b === undefined) continue;
      if (a.measures[0] <= b.measures[1] && b.measures[0] <= a.measures[1]) {
        addIssue(issues, 'ambiguous', `${path}.endings`, 'ending measure ranges must not overlap');
      }
    }
  }
}

function validateTempoMapSemantics(map: TempoMap): TempoMapValidationResult {
  const issues: TempoMapValidationIssue[] = [];

  if (map.id.trim().length === 0) addIssue(issues, 'required', 'id', 'must not be empty');
  if (map.repertoireItemId.trim().length === 0) {
    addIssue(issues, 'required', 'repertoireItemId', 'must not be empty');
  }
  if (!Number.isInteger(map.revision) || map.revision < 0) {
    addIssue(issues, 'integer', 'revision', 'must be a non-negative integer');
  }
  if (!isPositiveInteger(map.totalMeasures)) {
    addIssue(issues, 'integer', 'totalMeasures', 'must be a positive integer');
  }
  if (map.sections.length === 0) {
    addIssue(issues, 'required', 'sections', 'must contain at least one section');
  }

  const sectionIds = new Set<string>();
  let expectedStart = 1;
  map.sections.forEach((section, index) => {
    validateSection(section, index, map.totalMeasures, issues);
    if (sectionIds.has(section.id)) {
      addIssue(issues, 'duplicate', `sections[${index}].id`, 'must be unique');
    }
    sectionIds.add(section.id);
    if (section.startMeasure !== expectedStart) {
      addIssue(
        issues,
        'coverage',
        `sections[${index}].startMeasure`,
        section.startMeasure < expectedStart
          ? 'overlaps or is out of order with the previous section'
          : `leaves a gap before measure ${String(section.startMeasure)}`,
      );
    }
    expectedStart = section.endMeasure + 1;
  });
  if (map.sections.length > 0 && expectedStart !== map.totalMeasures + 1) {
    addIssue(issues, 'coverage', 'sections', 'must cover every measure exactly once');
  }

  if (map.anacrusis !== undefined) {
    const firstSection = map.sections[0];
    if (!isPositiveInteger(map.anacrusis.beats)) {
      addIssue(issues, 'integer', 'anacrusis.beats', 'must be a positive integer');
    } else if (
      firstSection !== undefined &&
      map.anacrusis.beats >= Math.round(beatsPerMeasure(firstSection))
    ) {
      addIssue(issues, 'range', 'anacrusis.beats', 'must be shorter than a complete first measure');
    }
  }
  if (map.countIn.measures !== 1 && map.countIn.measures !== 2) {
    addIssue(issues, 'range', 'countIn.measures', 'must be 1 or 2');
  }
  if (map.countIn.useSectionMeter !== true) {
    addIssue(issues, 'required', 'countIn.useSectionMeter', 'must be true');
  }

  validateMeasureExpressions(map, issues);

  const repeats: { directive: RepeatDirective; index: number }[] = [];
  let codaCount = 0;
  let requiresCoda = false;
  map.jumps.forEach((jump, index) => {
    const path = `jumps[${index}]`;
    if (jump.type === 'repeat') {
      validateRepeat(jump, index, map.totalMeasures, issues);
      repeats.push({ directive: jump, index });
      return;
    }
    if (jump.type === 'dc') {
      if (!isMeasure(jump.atMeasure, map.totalMeasures)) {
        addIssue(issues, 'jump', `${path}.atMeasure`, 'must be a measure in the map');
      }
      if (jump.alFine !== undefined && !isMeasure(jump.alFine, map.totalMeasures)) {
        addIssue(issues, 'jump', `${path}.alFine`, 'must be a measure in the map');
      }
      requiresCoda ||= jump.alCoda === true;
      return;
    }
    if (jump.type === 'ds') {
      if (!isMeasure(jump.atMeasure, map.totalMeasures)) {
        addIssue(issues, 'jump', `${path}.atMeasure`, 'must be a measure in the map');
      }
      if (!isMeasure(jump.segnoMeasure, map.totalMeasures)) {
        addIssue(issues, 'jump', `${path}.segnoMeasure`, 'must be a measure in the map');
      }
      if (jump.alFine !== undefined && !isMeasure(jump.alFine, map.totalMeasures)) {
        addIssue(issues, 'jump', `${path}.alFine`, 'must be a measure in the map');
      }
      requiresCoda ||= jump.alCoda === true;
      return;
    }

    codaCount += 1;
    if (!isMeasure(jump.toCodaMeasure, map.totalMeasures)) {
      addIssue(issues, 'jump', `${path}.toCodaMeasure`, 'must be a measure in the map');
    }
    if (!isMeasure(jump.codaMeasure, map.totalMeasures)) {
      addIssue(issues, 'jump', `${path}.codaMeasure`, 'must be a measure in the map');
    }
    if (jump.toCodaMeasure === jump.codaMeasure) {
      addIssue(issues, 'jump', path, 'To Coda and Coda must be different measures');
    }
  });

  if (codaCount > 1) {
    addIssue(issues, 'ambiguous', 'jumps', 'at most one coda directive is supported');
  }
  if (requiresCoda && codaCount !== 1) {
    addIssue(issues, 'jump', 'jumps', 'an alCoda directive requires exactly one coda directive');
  }

  for (let left = 0; left < repeats.length; left += 1) {
    const a = repeats[left];
    if (a === undefined) continue;
    for (let right = left + 1; right < repeats.length; right += 1) {
      const b = repeats[right];
      if (b === undefined) continue;
      const ar = a.directive;
      const br = b.directive;
      const identical = ar.startMeasure === br.startMeasure && ar.endMeasure === br.endMeasure;
      const crossesFromLeft =
        ar.startMeasure < br.startMeasure &&
        br.startMeasure <= ar.endMeasure &&
        ar.endMeasure < br.endMeasure;
      const crossesFromRight =
        br.startMeasure < ar.startMeasure &&
        ar.startMeasure <= br.endMeasure &&
        br.endMeasure < ar.endMeasure;
      if (identical || crossesFromLeft || crossesFromRight) {
        addIssue(
          issues,
          'ambiguous',
          `jumps[${String(b.index)}]`,
          `repeat range conflicts with jumps[${String(a.index)}]`,
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function validateTempoMap(input: unknown): TempoMapValidationResult {
  const structureIssues = validateTempoMapStructure(input);
  if (structureIssues.length > 0) return { valid: false, issues: structureIssues };
  return validateTempoMapSemantics(input as TempoMap);
}

export function assertValidTempoMap(map: unknown): asserts map is TempoMap {
  const result = validateTempoMap(map);
  if (!result.valid) throw new TempoMapValidationError(result.issues);
}
