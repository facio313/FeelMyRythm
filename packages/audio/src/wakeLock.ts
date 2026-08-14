import { AudioEnvironmentError } from './errors.js';

export interface WakeLockAdapter {
  readonly supported: boolean;
  readonly held: boolean;
  acquire(): Promise<void>;
  release(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockNavigatorLike {
  readonly wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface BrowserWakeLockOptions {
  readonly navigator?: WakeLockNavigatorLike;
  readonly document?: VisibilityDocumentLike;
  readonly onError?: (error: AudioEnvironmentError) => void;
}

/** Keeps the screen awake and reacquires after a visible-tab transition. */
export class BrowserWakeLockAdapter implements WakeLockAdapter {
  private readonly browserNavigator: WakeLockNavigatorLike | null;
  private readonly visibilityDocument: VisibilityDocumentLike | null;
  private readonly onError: ((error: AudioEnvironmentError) => void) | null;
  private sentinel: WakeLockSentinelLike | null = null;
  private desired = false;
  private disposed = false;

  constructor(options: BrowserWakeLockOptions = {}) {
    this.browserNavigator =
      options.navigator ??
      (typeof navigator === 'undefined' ? null : (navigator as WakeLockNavigatorLike));
    this.visibilityDocument =
      options.document ??
      (typeof document === 'undefined' ? null : (document as VisibilityDocumentLike));
    this.onError = options.onError ?? null;
    this.visibilityDocument?.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  get supported(): boolean {
    return this.browserNavigator?.wakeLock?.request !== undefined;
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  async acquire(): Promise<void> {
    if (this.disposed) {
      throw new AudioEnvironmentError(
        'wake-lock-request-failed',
        'This Wake Lock adapter has already been disposed.',
      );
    }
    this.desired = true;
    await this.requestLock();
  }

  async release(): Promise<void> {
    this.desired = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel !== null && !sentinel.released) await sentinel.release();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.visibilityDocument?.removeEventListener('visibilitychange', this.handleVisibilityChange);
    await this.release();
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.desired && !this.held && this.visibilityDocument?.visibilityState === 'visible') {
      void this.requestLock().catch((error: unknown) => {
        this.onError?.(toWakeLockError(error));
      });
    }
  };

  private async requestLock(): Promise<void> {
    const wakeLock = this.browserNavigator?.wakeLock;
    if (wakeLock === undefined) {
      throw new AudioEnvironmentError(
        'wake-lock-unsupported',
        'This browser does not provide the Screen Wake Lock API.',
      );
    }
    if (this.held) return;
    try {
      const sentinel = await wakeLock.request('screen');
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch (error) {
      throw toWakeLockError(error);
    }
  }
}

function toWakeLockError(error: unknown): AudioEnvironmentError {
  if (error instanceof AudioEnvironmentError) return error;
  return new AudioEnvironmentError(
    'wake-lock-request-failed',
    'The browser refused the Screen Wake Lock request.',
    { cause: error },
  );
}
