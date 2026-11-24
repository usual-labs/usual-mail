// The Cloudflare host's limits on memory and stored size (`HostLimits`, src/host.ts). An isolate has 128 MB. A row of
// the object's SQLite holds at most 8 MB, all its columns together (Cloudflare's limits page, read 2026-11-21; local
// workerd refuses a row a few bytes over 8 MiB, server/test/cloudflare/limits.test.ts). The values are smaller than
// those limits for memory. docs/agents/decisions-cloudflare.md, steps 4 and 5.

import type { HostLimits } from "../host.ts";

export const CLOUDFLARE_LIMITS: Required<HostLimits> = {
  // 25 converted messages at once. Gmail's own cap (2 MiB raw, GMAIL_SMALL_MEMORY) makes a message's text and HTML about
  // 2 MB of characters at most: about 50 MB for 25 when they are one-byte (Latin-1) characters in JavaScript, and about
  // 100 MB when every message is in a single-byte charset that isn't Latin-1 (Cyrillic, Greek), whose bytes become
  // two-byte characters; beside the two raw messages the shared gate allows. Ordinary mail is far smaller.
  syncBatch: 25,
  // A stored message's text, HTML and headers together: about a quarter of a row's 8 MB. HTML over 1,000,000
  // characters is never shown (MAX_SHOWN_HTML_LENGTH), so this keeps whole nearly every message a person can see as
  // sent, and it bounds what reading one message whole (a thread opened, the AI, a round of the search index) holds.
  storedMessageBytes: 1_900_000,
  // Four of the largest HTML shown (MAX_SHOWN_HTML_LENGTH, 1,000,000 characters), against Node's twenty-four.
  keptPictureChars: 4_000_000,
  // Threads read for the search index (their messages' heads, and attachment names) and written together.
  searchChunk: 20,
  // Text and HTML the search index reads at once: up to about 2 MB as JavaScript strings (one message more when a
  // single one is larger), however long the threads.
  searchReadChars: 1_000_000,
  // Start-up answers sooner, requests are answered between chunks, and a catch-up the object is reset during keeps the
  // chunks it finished.
  searchInBackground: true,
};
