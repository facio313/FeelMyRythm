export function temporarySingleUserModeEnabled(): boolean {
  return import.meta.env.VITE_FMR_TEMPORARY_SINGLE_USER === 'true';
}

export function portfolioSsoEnabled(): boolean {
  return import.meta.env.VITE_FMR_SSO_ENABLED === 'true';
}
