const STREAM_KEEPALIVE_INTERVAL_MS = 25_000;

export const withStandaloneStreamKeepalive = (
  response: Response,
  signal: AbortSignal,
): Response => {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.startsWith("text/event-stream") ||
    !response.body
  )
    return response;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  const clearPing = (): void => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    signal.removeEventListener("abort", clearPing);
  };
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  // Bun 1.3.11 calls this source's cancel hook on disconnect, unlike a TransformStream.
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode(": connected\n\n"));
      if (signal.aborted) return;
      signal.addEventListener("abort", clearPing);
      pingTimer = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, STREAM_KEEPALIVE_INTERVAL_MS);
    },
    pull: (controller) =>
      reader.read().then(
        ({ done, value }) => {
          if (finished) return;
          if (done) {
            finished = true;
            clearPing();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          clearPing();
          controller.error(error);
        },
      ),
    cancel: (reason) => {
      finished = true;
      clearPing();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, response);
};
