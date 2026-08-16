import { describe, expect, it } from 'vitest';

import { canonicalJoinCode, roomRefMatches, sessionPathForJoinInput } from './roomJoin';

const room = {
  roomId: '11111111-1111-4111-8111-111111111111',
  joinCode: '7K2M9A',
};

describe('room join codes', () => {
  it('accepts a 6-character verbal code case-insensitively', () => {
    expect(canonicalJoinCode('7k2m9a')).toBe('7K2M9A');
    expect(sessionPathForJoinInput(' 7k2m9a ')).toBe('/session/7K2M9A');
    expect(sessionPathForJoinInput(' 7k2-m9a ')).toBe('/session/7K2M9A');
    expect(roomRefMatches(room, '7k2m9a')).toBe(true);
  });

  it('keeps UUID invite links as the canonical room id path', () => {
    expect(sessionPathForJoinInput(room.roomId.toUpperCase())).toBe(`/session/${room.roomId}`);
    expect(roomRefMatches(room, room.roomId)).toBe(true);
    expect(canonicalJoinCode(room.roomId)).toBeNull();
  });

  it('rejects tokens that are neither a UUID nor a 6-character code', () => {
    expect(sessionPathForJoinInput('room')).toBeNull();
    expect(sessionPathForJoinInput('7K2M9')).toBeNull();
    expect(roomRefMatches(room, 'OTHER1')).toBe(false);
  });
});
