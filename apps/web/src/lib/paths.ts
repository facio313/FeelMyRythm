const viteBaseUrl = import.meta.env.BASE_URL;

/** React Router basename derived from the same Vite base used for built assets. */
export const APP_BASENAME = viteBaseUrl === '/' ? '/' : viteBaseUrl.replace(/\/$/, '');

/** Prefix an application-local absolute path with the deployment subpath. */
export function appPath(path: string): string {
  const absolutePath = path.startsWith('/') ? path : `/${path}`;
  if (APP_BASENAME === '/') return absolutePath;
  return `${APP_BASENAME}${absolutePath}`;
}
