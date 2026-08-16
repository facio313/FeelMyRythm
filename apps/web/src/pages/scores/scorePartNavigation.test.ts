import { describe, expect, it } from 'vitest';

import { nextPartIndex } from './scorePartNavigation';

describe('score part tab keyboard order', () => {
  it('moves with arrows and jumps to the visual first and last tabs', () => {
    expect(nextPartIndex('Home', 2, 3)).toBe(0);
    expect(nextPartIndex('End', 0, 3)).toBe(3);
    expect(nextPartIndex('ArrowLeft', 0, 3)).toBe(3);
    expect(nextPartIndex('ArrowRight', 3, 3)).toBe(0);
    expect(nextPartIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextPartIndex('Tab', 1, 3)).toBe(-1);
  });
});
