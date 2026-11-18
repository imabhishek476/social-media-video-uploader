import type { ApiErrorBody } from '@shorts/shared-types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

/** Thin fetch wrapper: JSON in/out, cookie session, typed errors. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

/** Human-readable message including field-level validation details. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = Array.isArray(error.details)
      ? (error.details as Array<{ path?: string; message?: string }>)
          .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
          .join('; ')
      : '';
    return details ? `${error.message} — ${details}` : error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}
