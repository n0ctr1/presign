/**
 * A per-client ceiling on work a request can cause before anyone pays.
 *
 * Pricing a full verdict counts the deployments it will check, which costs
 * registry lookups and calls against the fork. That happens on `GET /quote?to=`
 * and on the unpaid first half of the x402 exchange, both free by design — and a
 * caller walking through addresses would make the service do that work for
 * every one of them without paying for any. The count is cached per address, so
 * only cache misses are limited; repeating a price already held costs nothing.
 */

export interface RateLimiter {
  take(key: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };
}

export interface RateLimiterOptions {
  readonly perMinute: number;
  readonly now?: () => number;
  /** Clients remembered at once; the least recently seen is forgotten first. */
  readonly maxClients?: number;
}

const WINDOW_MS = 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const maxClients = options.maxClients ?? 10_000;
  const seen = new Map<string, number[]>();

  return {
    take(key) {
      const at = now();
      const recent = (seen.get(key) ?? []).filter((moment) => at - moment < WINDOW_MS);

      if (recent.length >= options.perMinute) {
        seen.set(key, recent);
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - at) / 1000)),
        };
      }

      recent.push(at);
      // Re-inserted so the map's order is least recently seen first, which is
      // what eviction below relies on.
      seen.delete(key);
      seen.set(key, recent);
      if (seen.size > maxClients) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return { ok: true };
    },
  };
}
