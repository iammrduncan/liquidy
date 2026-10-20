import { errorText } from "../log.ts";

export class ModelError extends Error {
  override name = "ModelError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** POSTs JSON and returns the parsed reply. Any failure, including a timeout, is a ModelError. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  let status: number;
  let text: string;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    throw new ModelError(`request to ${url} failed: ${errorText(e)}`);
  }
  if (status < 200 || status >= 300)
    throw new ModelError(`${url} returned ${status}: ${text.slice(0, 300)}`, status);
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError(`${url} returned a body that is not JSON: ${text.slice(0, 300)}`);
  }
}

export function bearer(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
