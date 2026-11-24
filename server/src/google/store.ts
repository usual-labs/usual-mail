// The Google sign-ins this process knows, by id and by the hash of their state. In memory only: a restart ends
// those still waiting, and nothing secret of a sign-in (its PKCE verifier) ever reaches the disk.

import type { Caller, GoogleSignIn, InboxIcon } from "@usualmail/core";

/** How long a finished sign-in's outcome can be read, from its start. */
const KEPT_MS = 60 * 60_000;

export interface Entry {
  id: string;
  stateHash: string;
  verifier: string;
  caller: Caller;
  deviceId: string;
  inboxId?: string;
  newInbox: { name?: string; color?: string; icon?: InboxIcon };
  startedAt: number;
  expiresAt: number;
  phase: "waiting" | "finishing" | "done";
  outcome?: Omit<GoogleSignIn, "id" | "expiresAt">;
}

/** What the page Google sends the person to says. */
export interface CallbackPage {
  status: number;
  title: string;
  message: string;
}

export class SignIns {
  readonly #byId = new Map<string, Entry>();
  readonly #byState = new Map<string, string>();

  add(entry: Entry): void {
    this.#byId.set(entry.id, entry);
    this.#byState.set(entry.stateHash, entry.id);
  }

  byId(id: string): Entry | undefined {
    return this.#byId.get(id);
  }

  byState(hash: string): Entry | undefined {
    const id = this.#byState.get(hash);
    return id === undefined ? undefined : this.#byId.get(id);
  }

  /** Forgets sign-ins whose outcome can no longer be read. */
  prune(now: number): void {
    for (const entry of this.#byId.values()) {
      if (entry.startedAt + KEPT_MS > now) continue;
      this.#byId.delete(entry.id);
      this.#byState.delete(entry.stateHash);
    }
  }
}

