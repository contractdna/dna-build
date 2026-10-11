// A POST whose only limit is its own deadline. Node's fetch (undici) gives up after 300 s without response headers,
// or 300 s without body bytes, whatever its signal says: a service that answers only when its run is done (the page
// check, a long model or image call) can take longer. node:http has no such limits on the client side.
// The answer comes back as a Response and failures read as fetch's do (a timeout is a TimeoutError, a transport error is
// "fetch failed" with the cause attached), so a caller swaps fetch for this and keeps its error handling.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/** The Fetch standard's null-body statuses: a Response with one of them can't carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** POST `body` (a string, or a form sent as multipart) to `url`; the whole exchange ends within `timeoutMs`. Any status resolves. */
export async function post(url: string, body: string | FormData, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
  const encoded = new Response(body); // the bytes, and a form's multipart content type
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const u = new URL(url);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), timeoutMs);
  try {
    const res = await new Promise<IncomingMessage>((ok, fail) => {
      const send = u.protocol === "https:" ? httpsRequest : httpRequest;
      // agent: false: a connection of its own (these calls are long), never a pooled one the server may have closed
      send(u, { method: "POST", agent: false, signal: deadline.signal, headers: { "content-type": encoded.headers.get("content-type") ?? "", ...headers, "content-length": bytes.length } }, ok)
        .on("error", fail)
        .end(bytes);
    });
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const h = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    const status = res.statusCode ?? 0;
    // the Response constructor throws on any body for a null-body status, even bytes a server wrongly sent with a 205
    return new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: h });
  } catch (e) {
    throw deadline.signal.aborted ? deadline.signal.reason : new TypeError("fetch failed", { cause: e });
  } finally {
    clearTimeout(timer);
  }
}
