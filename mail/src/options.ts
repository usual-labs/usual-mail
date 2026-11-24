/** Checks shared by both providers. */

export function checkSince(since: string | undefined): void {
  if (since !== undefined && Number.isNaN(Date.parse(since))) throw new Error("`since` must be an ISO 8601 time.");
}

export function checkLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("`limit` must be a positive whole number.");
  return limit;
}
