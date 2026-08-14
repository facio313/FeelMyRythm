import { describe, expect, it } from 'vitest';

import {
  AudioPerformanceMapper,
  OffsetServerPerformanceMapper,
  ServerAudioMapper,
} from '../src/index.js';

describe('audio/performance/server clock mappings', () => {
  it('maps through both clock domains and compensates output/calibration latency', () => {
    const audioPerformance = new AudioPerformanceMapper();
    audioPerformance.addSample(1_000, 5);
    audioPerformance.addSample(1_010, 5.01);
    audioPerformance.addSample(990, 4.99);
    const serverPerformance = new OffsetServerPerformanceMapper(1_700_000_000_000);
    const mapper = new ServerAudioMapper(serverPerformance, audioPerformance, () => 0.03);
    const serverTime = 1_700_000_002_000;

    expect(mapper.serverToAudio(serverTime)).toBeCloseTo(6, 8);
    expect(mapper.audioToServer(6)).toBeCloseTo(serverTime, 8);
    expect(mapper.serverToScheduledAudio(serverTime, 0.01)).toBeCloseTo(5.96, 8);
  });
});
