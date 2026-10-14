import { QueryClient } from '@tanstack/react-query';
import type { ApiError } from '@ptm/contracts';
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 3000, refetchInterval: 5000, refetchOnWindowFocus: true },
  },
});
let csrfToken = '';
export const setCsrf = (token: string) => {
  csrfToken = token;
};
export async function request<T>(
  path: string,
  data?: unknown,
  method = data === undefined ? 'GET' : 'POST',
  key?: string,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/session')
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    throw new Error((result as ApiError).message ?? 'Request failed');
  }
  return result as T;
}
export const time = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Unknown';
export const date = (at: number | null | undefined) => (at ? new Date(at).toLocaleString() : 'Unknown');
export const label = (value: string) =>
  value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^./, (x) => x.toUpperCase());
