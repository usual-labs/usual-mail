// What wrangler.jsonc binds to the Worker and the object. No secret is required: the Deploy button asks for none. The
// optional variables are set in the Worker's settings (wrangler.jsonc's `keep_vars` keeps them across deploys).

import type { GoogleEnv } from "./google.ts";
import type { UsualMailServer } from "./object.ts";
import type { SettingsEnv } from "./settings.ts";

export interface Env extends GoogleEnv, SettingsEnv {
  /** The one SQLite-backed Durable Object that holds the server, always the object named "server". */
  SERVER: DurableObjectNamespace<UsualMailServer>;
  /**
   * Optional Worker secret: 32 bytes in base64 that seal credentials. Without it a key is made and kept in storage.
   * Set it before connecting inboxes or giving the Google client (or copy the kept key into it): set later, it strands
   * every credential sealed with the kept key.
   */
  USUAL_MAIL_SECRET_KEY?: string;
  /** Optional plain variable: the HTTPS origin of a custom domain routed to the Worker (address.ts). */
  USUAL_MAIL_PUBLIC_URL?: string;
}
