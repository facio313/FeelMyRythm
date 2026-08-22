export type PortfolioAuthMode = 'sso' | 'local';

export interface PortfolioAuthBuildContract {
  branch: string;
  authMode: PortfolioAuthMode;
  managedLocalSso: boolean;
}

type BuildEnvironment = Record<string, string | undefined>;

function readBooleanAdapter(environment: BuildEnvironment, name: string): boolean | undefined {
  const value = environment[name];
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

export function expectedPortfolioAuthMode(branch: string): PortfolioAuthMode {
  return branch === 'main' || branch === 'dev' ? 'sso' : 'local';
}

export function resolvePortfolioAuthBuildContract(
  environment: BuildEnvironment,
): PortfolioAuthBuildContract {
  const branch = environment.PORTFOLIO_BRANCH?.replace(/^refs\/heads\//, '');
  if (!branch) {
    throw new Error(
      'PORTFOLIO_BRANCH is required; run the build through scripts/portfolio-auth-mode.sh',
    );
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('PORTFOLIO_BRANCH contains unsupported characters');
  }

  const expectedMode = expectedPortfolioAuthMode(branch);
  const authMode = environment.PORTFOLIO_AUTH_MODE;
  if (authMode !== 'sso' && authMode !== 'local') {
    throw new Error(
      'PORTFOLIO_AUTH_MODE must be sso or local; run the build through scripts/portfolio-auth-mode.sh',
    );
  }
  if (authMode !== expectedMode) {
    throw new Error(
      `PORTFOLIO_BRANCH=${branch} requires PORTFOLIO_AUTH_MODE=${expectedMode}, not ${authMode}`,
    );
  }

  const canonicalSsoEnabled = authMode === 'sso';
  const legacySsoEnabled = readBooleanAdapter(environment, 'VITE_FMR_SSO_ENABLED');
  if (legacySsoEnabled !== undefined && legacySsoEnabled !== canonicalSsoEnabled) {
    throw new Error('VITE_FMR_SSO_ENABLED conflicts with canonical PORTFOLIO_AUTH_MODE');
  }
  const managedLocalSso = readBooleanAdapter(environment, 'VITE_FMR_MANAGED_LOCAL_SSO') ?? false;
  if (managedLocalSso && !canonicalSsoEnabled) {
    throw new Error('VITE_FMR_MANAGED_LOCAL_SSO=true requires PORTFOLIO_AUTH_MODE=sso');
  }

  return { branch, authMode, managedLocalSso };
}
