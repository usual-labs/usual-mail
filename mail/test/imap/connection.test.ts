/**
 * The IMAP connection against hoodiecrow: readable login errors, reconnecting, the check before a quiet
 * connection is used again, IDLE watching, and closing without hanging.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createImapProvider } from "../../src/index.ts";
import { plainMessage, syncAll } from "../../src/testing/index.ts";
import { MODERN, USER, hoodiecrowHarness, type HoodiecrowServer } from "./servers.ts";

function message(subject: string) {
  return plainMessage({ from: "Bo <bo@people.example>", to: USER, subject });
}

async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type ServerSocket = { destroy(): void; removeAllListeners(event: string): void; on(event: string, fn: () => void): void };

function sockets(server: HoodiecrowServer): ServerSocket[] {
  const connections = (server as unknown as { connections: Set<{ socket?: ServerSocket }> }).connections;
  return [...connections].flatMap((connection) => (connection.socket ? [connection.socket] : []));
}

/** Makes every open connection swallow what the client sends, so nothing is ever answered again. */
function silence(server: HoodiecrowServer): void {
  for (const socket of sockets(server)) {
    socket.removeAllListeners("data");
    socket.on("data", () => {});
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("IMAP connection", () => {
  it("verify reports a wrong password readably, as a refused sign-in", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const bad = createImapProvider({
        imap: { host: "127.0.0.1", port: h.imapPort, secure: false, user: USER, password: "wrong" },
        smtp: { host: "127.0.0.1", port: h.smtp.port, secure: false, user: USER, password: "wrong" },
      });
      await assert.rejects(bad.verify(), (error: Error) =>
        error.name === "SignInRefused" && /refused the user name or password/.test(error.message));
      await bad.close();
    } finally {
      await h.close();
    }
  });

  it("reconnects after the server drops the connection", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      await h.deliver(message("Before the drop").raw);
      const state = await syncAll(h.provider, null);
      for (const socket of sockets(h.server)) socket.destroy();
      await h.deliver(message("After the drop").raw);
      const next = await syncAll(h.provider, state);
      assert.deepEqual([...next.messages.values()].map((m) => m.subject), ["After the drop"]);
    } finally {
      await h.close();
    }
  });

  it("checks a quiet connection with NOOP and keeps it when it answers", async () => {
    const h = await hoodiecrowHarness(MODERN, { timeouts: { quietMs: 50, probeMs: 2000 } });
    try {
      const state = await syncAll(h.provider, null);
      const [socket] = sockets(h.server);
      let noops = 0;
      const noop = h.server.getCommandHandler("NOOP");
      h.server.setCommandHandler("NOOP", (...args) => {
        noops++;
        return noop(...args);
      });
      await pause(120);
      await h.deliver(message("After a pause").raw);
      const next = await syncAll(h.provider, state);
      assert.deepEqual([...next.messages.values()].map((m) => m.subject), ["After a pause"]);
      assert.ok(noops >= 1, "the quiet connection was checked first");
      assert.deepEqual(sockets(h.server), [socket], "and used again");
    } finally {
      await h.close();
    }
  });

  it("opens a new connection when a quiet one no longer answers, instead of hanging on it", async () => {
    const h = await hoodiecrowHarness(MODERN, { timeouts: { quietMs: 50, probeMs: 300 } });
    try {
      const state = await syncAll(h.provider, null);
      silence(h.server);
      await pause(120);
      await h.deliver(message("Behind a dead connection").raw);
      const next = await within(5000, syncAll(h.provider, state), "a sync after the connection went silent");
      assert.deepEqual([...next.messages.values()].map((m) => m.subject), ["Behind a dead connection"]);
    } finally {
      await h.close();
    }
  });

  it("watch calls back when mail arrives, and stopping or closing doesn't hang", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      let calls = 0;
      let arrived!: () => void;
      const signal = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const stop = await h.provider.watch!(() => {
        calls++;
        arrived();
      });
      await pause(700); // let IDLE start
      await h.deliver(message("Ping").raw);
      await within(5000, signal, "the watch callback");
      assert.ok(calls >= 1);
      await within(5000, stop(), "stopping the watch");
      await h.provider.watch!(() => {}); // left running: close() must stop it
      await within(5000, h.provider.close(), "close");
    } finally {
      await h.close();
    }
  });

  it("close doesn't wait for a server that stopped answering", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      await h.provider.sync(null);
      silence(h.server);
      await within(6000, h.provider.close(), "close against a silent server");
    } finally {
      await h.close();
    }
  });
});
