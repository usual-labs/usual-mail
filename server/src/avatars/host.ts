// Host names as the avatar code compares them: ASCII, lower case, without a trailing dot, an international name in its
// xn-- form (the URL standard's conversion, the same in Node and in a worker). Anything that isn't a host name (an
// address literal, an empty label, a character a host name can't have, a numeric top label, which URL parsing would
// turn into an IPv4 address) is null, so it never becomes a key or an address to fetch.

/** The host name in ASCII, or null when it isn't one. */
export function asciiHost(value: string): string | null {
  const name = value.trim().replace(/\.$/, "");
  if (!name || name.length > 253 || !/^[\p{L}\p{N}\p{M}.-]+$/u.test(name)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${name}`).hostname;
  } catch {
    return null;
  }
  if (ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return ascii;
}
