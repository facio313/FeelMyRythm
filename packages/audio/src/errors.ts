export type AudioErrorCode =
  | 'audio-context-unsupported'
  | 'audio-context-closed'
  | 'audio-engine-not-started'
  | 'audio-sample-decode-failed'
  | 'worker-unsupported'
  | 'wake-lock-unsupported'
  | 'wake-lock-request-failed'
  | 'tuner-unsupported'
  | 'tuner-start-failed'
  | 'clock-mapping-uninitialized'
  | 'timeline-transition-unavailable';

/** A predictable, user-presentable failure at a browser/platform boundary. */
export class AudioEnvironmentError extends Error {
  readonly code: AudioErrorCode;

  constructor(code: AudioErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioEnvironmentError';
    this.code = code;
  }
}

export function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`);
}
