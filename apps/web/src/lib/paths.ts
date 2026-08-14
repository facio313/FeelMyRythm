declare const __FMR_MOBILE_SERVER_ORIGIN__: string;

export const APP_BASE = '/feelmyrythm';
export const IS_MOBILE_BUILD = import.meta.env.MODE === 'mobile';
export const ROUTER_BASENAME = IS_MOBILE_BUILD ? '/' : APP_BASE;

const serverOrigin = IS_MOBILE_BUILD ? __FMR_MOBILE_SERVER_ORIGIN__ : '';
export const API_BASE = `${serverOrigin}${APP_BASE}/api`;
const WS_PATH = `${APP_BASE}/ws`;

export function websocketUrl(path: string): string {
  const origin = serverOrigin || window.location.origin;
  const url = new URL(`${WS_PATH}${path.startsWith('/') ? path : `/${path}`}`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
