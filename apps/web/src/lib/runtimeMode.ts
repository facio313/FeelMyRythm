export function temporarySingleUserModeEnabled(): boolean {
  return import.meta.env.VITE_FMR_TEMPORARY_SINGLE_USER === 'true';
}
