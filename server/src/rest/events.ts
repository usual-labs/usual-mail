// GET /v1/events: a server-sent event stream. Each event is a MailEvent as JSON in `data:`, named by its
// type. A comment line every 25 seconds keeps the connection open and checks the token still works.

import type { Caller } from "@usualmail/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { MailServer } from "../service/server.ts";
import type { RestOptions } from "./app.ts";

export function eventStream(c: Context, server: MailServer, caller: Caller, token: string, options: RestOptions): Response {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let writing: Promise<unknown> = Promise.resolve();
    const write = (text: string) => {
      writing = writing.then(() => stream.write(text)).catch(() => undefined);
    };
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let cancelTimer: () => void = () => {};
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      cancelTimer();
      finish();
    };

    const unsubscribe = server.subscribe(caller, (event) => {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = () => {
      cancelTimer = options.scheduler.setTimer(options.keepAliveMs ?? 25_000, () => {
        void server.authenticate(token).then((still) => {
          if (!open) return;
          if (!still) return close();
          write(": keep-alive\n\n");
          keepAlive();
        }, () => close());
      });
    };
    stream.onAbort(close);
    write(": connected\n\n");
    keepAlive();
    await finished;
    await writing;
  });
}
