export function managedLocalSsoModeEnabled(): boolean {
  return import.meta.env.VITE_FMR_MANAGED_LOCAL_SSO === 'true';
}

export function portfolioSsoEnabled(): boolean {
  return import.meta.env.VITE_FMR_SSO_ENABLED === 'true';
}
