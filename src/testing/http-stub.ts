import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Stub {
  url: string;
  received: Received[];
  /** The body of the nth request; throws if there was none. */
  body(n: number): unknown;
  close(): Promise<void>;
}

/** A local server that answers every request with `reply` and records what it was sent. */
export async function stubServer(reply: { status?: number; body: unknown }): Promise<Stub> {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    body(n) {
      const request = received[n];
      if (!request) throw new Error(`the stub received ${received.length} requests, not ${n + 1}`);
      return request.body;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
