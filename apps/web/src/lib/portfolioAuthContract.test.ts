import { describe, expect, it } from 'vitest';
import {
  expectedPortfolioAuthMode,
  resolvePortfolioAuthBuildContract,
} from './portfolioAuthContract';

describe('portfolio auth build contract', () => {
  it.each([
    ['main', 'sso'],
    ['dev', 'sso'],
    ['codex', 'local'],
    ['feature/auth-contract', 'local'],
  ] as const)('maps %s to %s', (branch, expected) => {
    expect(expectedPortfolioAuthMode(branch)).toBe(expected);
    expect(
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: branch,
        PORTFOLIO_AUTH_MODE: expected,
      }),
    ).toMatchObject({ branch, authMode: expected, managedLocalSso: false });
  });

  it('normalizes refs/heads branch input', () => {
    expect(
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: 'refs/heads/main',
        PORTFOLIO_AUTH_MODE: 'sso',
      }).branch,
    ).toBe('main');
  });

  it('fails closed for missing or mismatched canonical inputs', () => {
    expect(() => resolvePortfolioAuthBuildContract({ PORTFOLIO_AUTH_MODE: 'local' })).toThrow(
      /PORTFOLIO_BRANCH is required/,
    );
    expect(() => resolvePortfolioAuthBuildContract({ PORTFOLIO_BRANCH: 'topic' })).toThrow(
      /PORTFOLIO_AUTH_MODE must be sso or local/,
    );
    expect(() =>
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: 'main',
        PORTFOLIO_AUTH_MODE: 'local',
      }),
    ).toThrow(/requires PORTFOLIO_AUTH_MODE=sso/);
  });

  it('accepts matching legacy adapters and rejects conflicts', () => {
    expect(
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: 'main',
        PORTFOLIO_AUTH_MODE: 'sso',
        VITE_FMR_SSO_ENABLED: 'true',
        VITE_FMR_MANAGED_LOCAL_SSO: 'true',
      }).managedLocalSso,
    ).toBe(true);
    expect(() =>
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: 'main',
        PORTFOLIO_AUTH_MODE: 'sso',
        VITE_FMR_SSO_ENABLED: 'false',
      }),
    ).toThrow(/VITE_FMR_SSO_ENABLED conflicts/);
    expect(() =>
      resolvePortfolioAuthBuildContract({
        PORTFOLIO_BRANCH: 'feature/local',
        PORTFOLIO_AUTH_MODE: 'local',
        VITE_FMR_MANAGED_LOCAL_SSO: 'true',
      }),
    ).toThrow(/requires PORTFOLIO_AUTH_MODE=sso/);
  });
});
