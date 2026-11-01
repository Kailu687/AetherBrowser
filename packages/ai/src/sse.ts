/** Split a byte stream into lines (for NDJSON and server-sent events). */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
      }
    }
    buf += dec.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** Yield `data:` payloads of an SSE stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of lines(body)) {
    if (line.startsWith("data:")) yield line.slice(5).trimStart();
  }
}
