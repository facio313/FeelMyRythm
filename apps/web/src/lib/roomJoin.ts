const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export interface RoomJoinIdentity {
  roomId: string;
  joinCode: string;
}

export function normalizeRoomRef(value: string): string {
  return value.trim().replaceAll(/\s+/g, '');
}

export function canonicalJoinCode(value: string): string | null {
  const compact = normalizeRoomRef(value).replaceAll('-', '').toUpperCase();
  return JOIN_CODE_PATTERN.test(compact) ? compact : null;
}

export function roomRefMatches(room: RoomJoinIdentity, ref: string): boolean {
  const token = normalizeRoomRef(ref);
  if (token.toLowerCase() === room.roomId.toLowerCase()) return true;
  return canonicalJoinCode(token) === room.joinCode;
}

export function sessionPathForJoinInput(value: string): string | null {
  const token = normalizeRoomRef(value);
  if (UUID_PATTERN.test(token)) return `/session/${token.toLowerCase()}`;
  const joinCode = canonicalJoinCode(token);
  return joinCode ? `/session/${joinCode}` : null;
}
