import { decodeRef } from "./cursor.ts";

/**
 * Refs this provider gave messages by moving them itself. `apply` returns each new ref and the server stores
 * it, so the server already holds the message under that ref: `sync` then sends it as a change (its flags and
 * placement) instead of downloading it again. Stacks and come-back times move messages often, so this saves
 * most downloads.
 *
 * Kept in memory only, and bounded. After a restart, or once a ref falls out, a moved message is downloaded
 * once more and the server matches it by ref, which is harmless. A moved message gone before a sync saw it (another
 * app moved it on) is reported removed: the server holds its ref, and needs that removal to take the copy where it
 * went as the same message (it never takes a copy by Message-ID and content while the one it holds may be there).
 */
export class OwnMoves {
  readonly #refs = new Set<string>();
  readonly #limit: number;

  constructor(limit = 10_000) {
    this.#limit = limit;
  }

  /** The message at `from` now sits at `to`, moved by this provider. */
  moved(from: string, to: string): void {
    this.#refs.delete(from);
    this.#refs.delete(to);
    this.#refs.add(to);
    while (this.#refs.size > this.#limit) this.#refs.delete(this.#refs.values().next().value!);
  }

  has(ref: string): boolean {
    return this.#refs.has(ref);
  }

  /** The refs this provider gave by moving into a folder, still unreported. */
  in(path: string, uidValidity: string): string[] {
    return [...this.#refs].filter((ref) => {
      const location = decodeRef(ref);
      return location?.path === path && location.uidValidity === uidValidity;
    });
  }

  /** Forgets refs once they were reported, so each is sent as a change at most once. */
  reported(refs: Iterable<string>): void {
    for (const ref of refs) this.#refs.delete(ref);
  }
}
