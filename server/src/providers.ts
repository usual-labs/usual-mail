// Which code talks to which kind of mailbox. `src/node/parts.ts` lists the providers a normal run uses; the
// demo and the tests register `MemoryProvider`.

import type { ProviderFactory, ProviderKind } from "@usualmail/core";

export class ProviderRegistry {
  #factories = new Map<ProviderKind, ProviderFactory>();

  register(kind: ProviderKind, factory: ProviderFactory): void {
    this.#factories.set(kind, factory);
  }

  get(kind: ProviderKind): ProviderFactory | undefined {
    return this.#factories.get(kind);
  }

  kinds(): ProviderKind[] {
    return [...this.#factories.keys()];
  }
}
