// Imported first by main.ts, so SIGTERM and SIGINT have a handler before the rest of the server is even loaded. In the
// container Node runs as PID 1, and PID 1 ignores a signal it has no handler for: when the handler came only after
// start-up, a `docker stop` during start-up waited out the container's whole time to stop (three minutes) and was
// then killed. A signal is remembered here until main.ts can act on it safely. The server ignores a second one.

const asked = new AbortController();
let action: (() => void) | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (asked.signal.aborted) return;
    asked.abort();
    action?.();
  });
}

/** Aborted once the server has been asked to stop. */
export const stopAsked: AbortSignal = asked.signal;

/** What to do when asked to stop: at once if that has happened already, otherwise at the first signal. */
export function onStop(stop: () => void): void {
  action = stop;
  if (asked.signal.aborted) stop();
}
