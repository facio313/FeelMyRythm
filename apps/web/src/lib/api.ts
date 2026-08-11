import { useAuth } from './auth';
import { appPath } from './paths';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parseError(res: Response): Promise<never> {
  let message = `요청 실패 (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') message = body.detail;
  } catch {
    // JSON이 아니면 기본 메시지 유지
  }
  throw new ApiError(res.status, message);
}

function authHeaders(): Record<string, string> {
  const token = useAuth.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(appPath(path), { ...init, headers: { ...headers, ...init?.headers }, body });
  if (!res.ok) await parseError(res);
  return (await res.json()) as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(appPath(path), { method: 'POST', headers: authHeaders(), body: form });
  if (!res.ok) await parseError(res);
  return (await res.json()) as T;
}

export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(appPath(path), { headers: authHeaders() });
  if (!res.ok) await parseError(res);
  return await res.blob();
}
