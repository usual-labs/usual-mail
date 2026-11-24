// Signing in with Google from the command: the server starts the sign-in, the command opens Google's address in the
// browser (or only prints it), then asks the server how it ended until it isn't waiting any more. The command never
// sees a code or a token: Google sends the browser back to the server itself (docs/contract-sync.md).

import type { GoogleSignIn, GoogleSignInInput, GoogleSignInStart } from "@usualmail/core";
import type { Client } from "./client.ts";
import { note, type Context } from "./context.ts";
import { utc } from "./format.ts";

/** How often the command asks the server how the sign-in stands. */
const POLL_MS = 1_000;
/** A little past the sign-in's expiry, when the server will have said it expired. */
const GRACE_MS = 15_000;

export async function signInWithGoogle(
  ctx: Context,
  client: Client,
  input: GoogleSignInInput,
  options: { browser: boolean },
): Promise<GoogleSignIn> {
  const started = await client.call<GoogleSignInStart>("startGoogleSignIn", { body: input });
  note(ctx, "Sign in with Google in your browser. Google may warn that the app isn't verified: continue if it is your own Google client.");
  note(ctx, started.url);
  if (options.browser && !(await openBrowser(ctx, started.url))) note(ctx, "Couldn't open a browser here: open the address above yourself.");
  note(ctx, `Waiting for you to come back from Google (until ${utc(started.expiresAt)})…`);
  const giveUp = Date.parse(started.expiresAt) + GRACE_MS;
  for (;;) {
    await ctx.sleep(POLL_MS);
    const now = await client.call<GoogleSignIn>("googleSignIn", { params: { id: started.id } });
    if (now.state !== "waiting" || ctx.now() > giveUp) return now;
  }
}

/** Opens a web address in the person's browser with the system's own opener. Only http(s), as one argument. */
async function openBrowser(ctx: Context, url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await ctx.runner.run(opener, [url], { timeoutMs: 10_000 }).catch(() => null);
  return result !== null && result.code === 0;
}
