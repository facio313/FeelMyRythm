export function managedLocalSsoModeEnabled(): boolean {
  const adapter = import.meta.env.VITE_FMR_MANAGED_LOCAL_SSO;
  if (adapter === 'true' || adapter === 'false') return adapter === 'true';
  return __FMR_MANAGED_LOCAL_SSO__;
}

export function portfolioSsoEnabled(): boolean {
  const adapter = import.meta.env.VITE_FMR_SSO_ENABLED;
  if (adapter === 'true' || adapter === 'false') return adapter === 'true';
  return __FMR_PORTFOLIO_AUTH_MODE__ === 'sso';
}
