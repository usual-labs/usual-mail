// Pictures from the web and sender pictures' site icons on Cloudflare, both on as on Node (the owner's decision of
// 2026-11-21): the picture source over the object's own SQLite, the shared site-icon discovery over the Worker's fetcher.

import { SiteIcons } from "../../avatars/site-icons.ts";
import type { PictureSource, SiteIconSource } from "../../host.ts";
import { fetchWebBytes, postOneClick } from "./fetch.ts";
import { createPictureTables, SqlPictureSource } from "./pictures.ts";

/** Pictures fetched from the web at once: two, against Node's six, in a 128 MB isolate (each up to 10 MB). */
export const PICTURE_CONCURRENCY = 2;

/** Both sources, their tables created first; neither fetches from the server's own hosts (`ownHost`). */
export function webSources(
  storage: DurableObjectStorage,
  ownHost: (host: string) => boolean,
): { pictures: PictureSource; siteIcons: SiteIconSource; oneClick: (url: string) => Promise<number> } {
  createPictureTables(storage.sql);
  return {
    pictures: new SqlPictureSource(storage, { concurrency: PICTURE_CONCURRENCY, fetch: async (url) => (await fetchWebBytes(url, { ownHost })).bytes }),
    siteIcons: new SiteIcons((url, request) => fetchWebBytes(url, { ...request, ownHost })),
    // A sender's one-click unsubscribe (docs/contract.md, "Unsubscribing"), under the same rules.
    oneClick: (url) => postOneClick(url, { ownHost }),
  };
}
