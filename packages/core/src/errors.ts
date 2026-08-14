import type { TempoMapValidationIssue } from './types.js';

export class TempoMapValidationError extends Error {
  readonly issues: readonly TempoMapValidationIssue[];

  constructor(issues: readonly TempoMapValidationIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super(`Invalid TempoMap: ${detail}`);
    this.name = 'TempoMapValidationError';
    this.issues = issues;
  }
}

export class TimelineExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineExpansionError';
  }
}
