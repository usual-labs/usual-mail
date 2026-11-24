// The rules every host's fetcher of pictures from the web keeps (docs/contract-pictures.md, "What is fetched, and how"),
// as data both fetchers share: Node's (`src/node/pictures/fetch.ts`, which also pins the connection to the address it
// checked) and Cloudflare's (`src/cloudflare/web/fetch.ts`, which can't). The special-purpose ranges come from IANA's
// IPv4 and IPv6 special-purpose address registries; an IPv6 address must also be global unicast (2000::/3).

/** IPv4 ranges that are never fetched from. */
export const IPV4_SPECIAL: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier NAT, Tailscale), and a cloud metadata address in it
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, with the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

/** Parts of global unicast IPv6 (2000::/3) that are never fetched from. */
export const IPV6_SPECIAL: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID and others
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which wraps an IPv4 address
  ["3fff::", 20], // documentation
];

/** A picture: at most 10 MB and 15 seconds (the name's lookup included), five seconds to an answer, three redirects. */
export const PICTURE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
  maxRedirects: 3,
};

/** Each DNS question: its time limit and how many times it is asked. */
export const DNS_LIMITS = { timeoutMs: 2_000, tries: 2 };

/** Apple Mail's user agent: common, and the same for every picture, so it tells a site nothing about the person. */
export const PICTURE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** What a picture request asks for: the picture types the server shows. */
export const PICTURE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8";

/** The answers that are redirects, each checked again before it is followed. */
export const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The ports pictures are fetched from: 80 for http, 443 for https. */
export const usualPorts = (port: number, protocol: "http:" | "https:"): boolean => port === (protocol === "https:" ? 443 : 80);
