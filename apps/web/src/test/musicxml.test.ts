import { describe, expect, it } from 'vitest';
import { expandTimeline } from '@feelmyrythm/core';
import { musicXmlToTempoMap } from '../lib/musicxml';

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="100"/></direction>
      <barline location="left"><repeat direction="forward"/></barline>
    </measure>
    <measure number="2"/>
    <measure number="3">
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>130</per-minute></metronome></direction-type></direction>
    </measure>
    <measure number="4"><barline location="right"><repeat direction="backward" times="2"/></barline></measure>
  </part>
</score-partwise>`;

describe('MusicXML import', () => {
  it('creates a deterministic tempo-map draft with changes and repeats', () => {
    const map = musicXmlToTempoMap(fixture, 'Fixture');
    expect(map.totalMeasures).toBe(4);
    expect(map.sections).toHaveLength(2);
    expect(map.sections[0]?.bpm).toBe(100);
    expect(map.sections[1]?.startMeasure).toBe(3);
    expect(map.sections[1]?.bpm).toBe(130);
    expect(map.jumps).toEqual([{ type: 'repeat', startMeasure: 1, endMeasure: 4, times: 2 }]);
    expect(expandTimeline(map).entries).toHaveLength(8);
  });
});
