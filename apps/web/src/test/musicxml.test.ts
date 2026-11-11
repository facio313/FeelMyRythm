import { describe, expect, it } from 'vitest';
import { expandTimeline } from '@feelmyrythm/core';
import { strToU8, zipSync } from 'fflate';
import { musicXmlToTempoMap, readMusicXml } from '../lib/musicxml';

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
  const archiveFile = (bytes: Uint8Array) => {
    const file = new File([new Uint8Array(bytes)], 'score.mxl');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array(bytes).buffer });
    return file;
  };

  it('selects the declared score without inflating unrelated archive entries', async () => {
    const bytes = zipSync({
      'META-INF/container.xml': strToU8(
        '<container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>',
      ),
      'other.xml': strToU8('wrong score'),
      'scores/main.musicxml': strToU8(fixture),
      'unused.bin': strToU8('unrelated attachment'),
    });
    // An unsupported compression method in an unused attachment must not be decoded.
    const view = new DataView(bytes.buffer);
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name === 'unused.bin') view.setUint16(offset + 10, 99, true);
    }
    expect(await readMusicXml(archiveFile(bytes))).toBe(fixture);
  });

  it('ignores META-INF XML and accepts uppercase score extensions in container-less archives', async () => {
    const bytes = zipSync({
      'META-INF/metadata.xml': strToU8('<metadata/>'),
      'SCORE.MUSICXML': strToU8(fixture),
    });
    expect(await readMusicXml(archiveFile(bytes))).toBe(fixture);
  });

  it('rejects a missing declared rootfile rather than silently selecting another score', async () => {
    const bytes = zipSync({
      'META-INF/container.xml': strToU8(
        '<container><rootfile full-path="missing.xml"/></container>',
      ),
      'other.xml': strToU8(fixture),
    });
    await expect(readMusicXml(archiveFile(bytes))).rejects.toThrow(
      '지정된 MusicXML 파일이 없습니다',
    );
  });

  it('rejects an oversized XML entry before allocating its decompressed output', async () => {
    const bytes = zipSync({ 'score.xml': strToU8(fixture) });
    const view = new DataView(bytes.buffer);
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 50 * 1024 * 1024 + 1, true);
        break;
      }
    }
    await expect(readMusicXml(archiveFile(bytes))).rejects.toThrow('압축 해제 크기 제한');
  });

  it('bounds container metadata and rejects malformed metadata', async () => {
    const oversized = zipSync({
      'META-INF/container.xml': strToU8(' '.repeat(64 * 1024 + 1)),
      'score.xml': strToU8(fixture),
    });
    await expect(readMusicXml(archiveFile(oversized))).rejects.toThrow('압축 해제 크기 제한');
    const malformed = zipSync({
      'META-INF/container.xml': strToU8('<container>'),
      'score.xml': strToU8(fixture),
    });
    await expect(readMusicXml(archiveFile(malformed))).rejects.toThrow('container.xml 문법');
  });

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
