import { Fault } from '../../contracts/src/fault.ts';
export type Http = typeof fetch;
export class ProviderHttpError extends Fault {
  constructor(
    public providerStatus: number,
    public retryAfterMs = 0,
  ) {
    super(
      'PROVIDER_REQUEST_FAILED',
      `Provider request failed (HTTP ${providerStatus}). Credentials and response bodies are withheld.`,
      502,
      providerStatus === 429 || providerStatus >= 500,
    );
  }
}
export async function providerRequest(
  http: Http,
  url: string,
  token: string,
  method = 'GET',
  body?: unknown,
) {
  let response: Response;
  try {
    response = await http(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  } catch {
    throw new Fault(
      'PROVIDER_OUTCOME_UNKNOWN',
      'Provider timed out or could not be reached. Inspect actual state before repeating a mutation.',
      502,
      true,
    );
  }
  if (!response.ok) {
    const after = response.headers.get('retry-after');
    const ms =
      after && /^\d+$/.test(after)
        ? Number(after) * 1000
        : after
          ? Math.max(0, Date.parse(after) - Date.now())
          : 0;
    throw new ProviderHttpError(response.status, Math.min(ms || 0, 120000));
  }
  if (response.status === 204) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Fault('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid response', 502);
  }
}
