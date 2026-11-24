// Node's site icon source for sender pictures (docs/contract-avatars.md): the shared discovery (`SiteIcons`,
// src/avatars/site-icons.ts) over Node's fetcher, `fetchWebBytes`, which keeps every rule pictures from the web follow:
// public addresses only, pinned DNS, every redirect checked, no cookies or referrer, a common user agent, no
// compression, caps on bytes and time.

import { SiteIcons, type SiteIconsOptions } from "../../avatars/site-icons.ts";
import { fetchWebBytes, type FetchOptions } from "../pictures/fetch.ts";

export { SITE_LIMITS } from "../../avatars/site-icons.ts";

export interface SiteIconOptions extends Omit<SiteIconsOptions, "requestTimeoutMs"> {
  /** For the fetcher: only tests give any (a fake resolver, their own fake host). */
  fetchOptions?: FetchOptions;
}

export class NodeSiteIcons extends SiteIcons {
  constructor(options: SiteIconOptions = {}) {
    const { fetchOptions = {}, ...rest } = options;
    super((url, request) => fetchWebBytes(url, { ...fetchOptions, ...request }), { ...rest, requestTimeoutMs: fetchOptions.totalTimeoutMs ?? 15_000 });
  }
}
