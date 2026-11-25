// The memory mailbox's `MailProvider` (memory-provider.ts has the mailbox): what the server opens for an inbox in tests
// and demo mode, and the factory a provider registry takes.

import type {
  FromCheck,
  InboxConnection,
  MailProvider,
  OutgoingMessage,
  ProviderKind,
  ProviderOp,
  ProviderOpResult,
  ProviderOptions,
  SendResult,
  SyncBatch,
  SyncOptions,
} from "@usualmail/core";
import { MemoryMailbox, type MemoryMailboxOptions } from "./memory-provider.ts";
import { memorySearch, memoryThread } from "./memory-search.ts";

/** A `MailProvider` over a `MemoryMailbox`. */
export class MemoryProvider implements MailProvider {
  readonly kind: ProviderKind;
  readonly mailbox: MemoryMailbox;
  readonly #since: number | null;
  readonly #connection: InboxConnection | undefined;
  /** Whether the server asked for what the provider's checker proved: then delivered `fromCheck`s are reported. */
  readonly #authentication: boolean;
  closed = false;
  watch?: (onChange: () => void) => Promise<() => Promise<void>>;
  /** Like Gmail's: a memory "gmail" mailbox asked for authentication reads delivered `fromCheck`s again. */
  fromChecks?: (refs: readonly string[]) => Promise<Map<string, FromCheck>>;
  /** Like Gmail's: a memory "gmail" mailbox searches itself (memory-search.ts); an "imap" one can't. */
  search?: MailProvider["search"];
  fetchThread?: MailProvider["fetchThread"];

  constructor(mailbox: MemoryMailbox, options: ProviderOptions = {}, connection?: InboxConnection) {
    this.mailbox = mailbox;
    this.kind = mailbox.kind;
    this.#since = options.since ? Date.parse(options.since) : null;
    this.#connection = connection;
    this.#authentication = options.authentication !== undefined;
    if (this.#authentication && mailbox.kind === "gmail") {
      this.fromChecks = async (refs) => {
        mailbox.fromCheckReads.push([...refs]);
        const out = new Map<string, FromCheck>();
        for (const ref of refs) {
          const message = mailbox.get(ref);
          if (message) out.set(ref, message.fromCheck ?? { result: "no_header" });
        }
        return out;
      };
    }
    if (mailbox.kind === "gmail") {
      this.search = async (query, options) => {
        const failure = mailbox.failure();
        if (failure) throw failure;
        mailbox.searches.push(structuredClone(query));
        return memorySearch(mailbox.reported(), query, options);
      };
      this.fetchThread = async (threadKey) => {
        const failure = mailbox.failure();
        if (failure) throw failure;
        return memoryThread(mailbox.reported(), threadKey);
      };
    }
    if (mailbox.options.watch) {
      this.watch = async (onChange) => {
        const stop = mailbox.watch(onChange);
        return async () => stop();
      };
    }
  }

  connection(): InboxConnection {
    return structuredClone(this.#connection ?? this.mailbox.connection);
  }

  async verify(): Promise<{ address: string }> {
    const failure = this.mailbox.failure();
    if (failure) throw failure;
    return { address: this.mailbox.address };
  }

  async sync(cursor: string | null, options?: SyncOptions): Promise<SyncBatch> {
    const batch = await this.mailbox.sync(cursor, this.#since, options?.limit);
    // A checker's word only when the server asked for it, as the real providers do.
    if (!this.#authentication) {
      for (const message of batch.upserted) {
        delete message.fromCheck;
        delete message.signedRecipients;
      }
    }
    return batch;
  }

  async fetchAttachment(ref: string, attachmentId: string): Promise<Uint8Array> {
    return this.mailbox.fetchAttachment(ref, attachmentId);
  }

  async apply(ops: ProviderOp[]): Promise<ProviderOpResult[]> {
    return this.mailbox.apply(ops);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    return this.mailbox.send(message);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * A factory for `ProviderRegistry.register`. Credentials are `{ "mailbox": "<address>" }`, optionally with the
 * `connection` the provider should report (and anything else, such as a password, which it ignores); an address
 * it hasn't seen gets a new, empty mailbox.
 */
export function memoryFactory(mailboxes: Map<string, MemoryMailbox>, defaults: Omit<MemoryMailboxOptions, "address"> = {}) {
  return (credentials: unknown, options?: ProviderOptions): MemoryProvider => {
    const connection = (credentials as { connection?: InboxConnection } | null)?.connection;
    const address = (credentials as { mailbox?: unknown } | null)?.mailbox;
    if (typeof address !== "string" || !address.includes("@")) throw new Error('Memory credentials are { "mailbox": "<address>" }');
    let mailbox = mailboxes.get(address.toLowerCase());
    if (!mailbox) {
      mailbox = new MemoryMailbox({ ...defaults, address });
      mailboxes.set(mailbox.address, mailbox);
    }
    return mailbox.provider(options, connection);
  };
}
