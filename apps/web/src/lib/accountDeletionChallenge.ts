interface AccountIdentity {
  id: string;
  email: string;
}

interface PendingAccountDeletionChallenge {
  proof: string;
  userId: string;
  email: string;
}

export type AccountDeletionChallengeStatus =
  | { kind: 'none' }
  | { kind: 'login-required' }
  | { kind: 'wrong-account' }
  | { kind: 'ready'; proof: string };

let pendingChallenge: PendingAccountDeletionChallenge | null = null;

function decodeBase64UrlJson(value: string): unknown {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - remainder) % 4);
  try {
    const binary = window.atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function identityFromProof(proof: string): Omit<PendingAccountDeletionChallenge, 'proof'> | null {
  if (!proof || proof.length > 8_192) return null;
  const parts = proof.split('.');
  if (parts.length !== 3) return null;
  const payload = decodeBase64UrlJson(parts[1] ?? '');
  if (typeof payload !== 'object' || payload === null) return null;
  const claims = payload as Record<string, unknown>;
  if (
    claims.typ !== 'account_delete' ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.email !== 'string' ||
    !claims.email.trim() ||
    typeof claims.google_sub !== 'string' ||
    !claims.google_sub ||
    typeof claims.gen !== 'number' ||
    !Number.isInteger(claims.gen)
  ) {
    return null;
  }
  return { userId: claims.sub, email: claims.email.trim().toLowerCase() };
}

/**
 * Keeps the one-time proof only in this JavaScript runtime. The decoded claims are routing hints;
 * the server remains authoritative for signature, expiry, generation, and Google subject checks.
 */
export function captureAccountDeletionChallenge(proof: string): boolean {
  const identity = identityFromProof(proof);
  pendingChallenge = identity ? { proof, ...identity } : null;
  return Boolean(identity);
}

export function accountDeletionChallengeStatus(
  user: AccountIdentity | null,
): AccountDeletionChallengeStatus {
  if (!pendingChallenge) return { kind: 'none' };
  if (!user) return { kind: 'login-required' };
  if (
    user.id !== pendingChallenge.userId ||
    user.email.trim().toLowerCase() !== pendingChallenge.email
  ) {
    return { kind: 'wrong-account' };
  }
  return { kind: 'ready', proof: pendingChallenge.proof };
}

export function clearAccountDeletionChallenge(): void {
  pendingChallenge = null;
}
