/**
 * Addresses known to be involved in phishing or theft.
 *
 * R1 used to be handed a list by whoever wired it. The deployed service handed
 * it nothing, and the demo handed it `0x…deadbeef` — so the one approval
 * finding that reached `high` did so against an address nobody had ever
 * reported. This module replaces the stand-in with a list somebody actually
 * maintains: ScamSniffer's open address blacklist, refreshed daily upstream.
 *
 * ## What a denylist can and cannot say
 *
 * It only ever raises a verdict. An address on it is evidence; an address
 * absent from it is evidence of nothing, because a drainer deployed this
 * morning is on no list. That asymmetry is why a feed that failed to load does
 * not make R1 unavailable: nothing R1 concludes rests on an address being
 * *absent*. An unlimited approval to an unlisted spender is still a warning.
 * What a failed load costs is the upgrade from warning to critical, so the
 * feed's state is reported on every flagged finding and on /health, where a
 * reader can see which case applies.
 *
 * ScamSniffer publishes the open list with a seven-day delay and keeps the
 * real-time data for paying customers, so this lags the newest drainers by at
 * least a week. The status says so rather than leaving it to be discovered.
 *
 * The data is GPL-3.0 and is fetched at runtime, never copied into this
 * repository.
 */

export interface IncidentRegistryStatus {
  /** Who maintains the list. */
  readonly source: string;
  readonly url: string | null;
  /** False until a list has been loaded at least once. */
  readonly loaded: boolean;
  readonly entries: number;
  /** When the list in memory was fetched, not when upstream last changed it. */
  readonly fetchedAt: string | null;
  /** The last refresh failure, kept while an older list stays in use. */
  readonly lastError: string | null;
  readonly note: string;
}

export interface IncidentRegistry {
  has(address: string): boolean;
  status(): IncidentRegistryStatus;
}

/** A fixed list, for tests and for operators who maintain their own. */
export class StaticIncidentRegistry implements IncidentRegistry {
  readonly #addresses: ReadonlySet<string>;
  readonly #source: string;

  constructor(addresses: Iterable<string>, source = "configured list") {
    this.#addresses = new Set([...addresses].map((a) => a.toLowerCase()));
    this.#source = source;
  }

  has(address: string): boolean {
    return this.#addresses.has(address.toLowerCase());
  }

  status(): IncidentRegistryStatus {
    return {
      source: this.#source,
      url: null,
      loaded: true,
      entries: this.#addresses.size,
      fetchedAt: null,
      lastError: null,
      note: "supplied by the operator, not fetched",
    };
  }
}

export const SCAM_SNIFFER_ADDRESS_LIST =
  "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface ScamSnifferFeedOptions {
  readonly url?: string;
  /** How often to re-fetch. Upstream changes daily, so hours are plenty. */
  readonly refreshSeconds?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export class ScamSnifferIncidentFeed implements IncidentRegistry {
  readonly #url: string;
  readonly #refreshSeconds: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  #addresses: ReadonlySet<string> = new Set();
  #fetchedAt: Date | null = null;
  #lastError: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScamSnifferFeedOptions = {}) {
    this.#url = options.url ?? SCAM_SNIFFER_ADDRESS_LIST;
    this.#refreshSeconds = options.refreshSeconds ?? 6 * 3600;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Fetch the list and swap it in, or keep the previous one.
   *
   * A failed refresh never empties the set. Unlearning addresses already known
   * to be malicious because GitHub returned a 503 would turn an outage into a
   * silent downgrade of every flagged approval, which is the opposite of what a
   * refresh is for. An upstream change that parses to nothing is treated the
   * same way, for the same reason.
   */
  async refresh(): Promise<void> {
    try {
      const response = await this.#fetch(this.#url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("expected a JSON array of addresses");

      const next = new Set<string>();
      for (const entry of body) {
        if (typeof entry === "string" && ADDRESS.test(entry)) next.add(entry.toLowerCase());
      }
      if (next.size === 0) throw new Error("the list parsed to zero addresses");

      this.#addresses = next;
      this.#fetchedAt = this.#now();
      this.#lastError = null;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Refresh periodically. The timer does not keep a process alive. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.refresh(), this.#refreshSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  has(address: string): boolean {
    return this.#addresses.has(address.toLowerCase());
  }

  status(): IncidentRegistryStatus {
    return {
      source: "ScamSniffer scam-database",
      url: this.#url,
      loaded: this.#fetchedAt !== null,
      entries: this.#addresses.size,
      fetchedAt: this.#fetchedAt?.toISOString() ?? null,
      lastError: this.#lastError,
      note:
        "open data published with a seven-day delay; an address absent from it is not evidence of safety",
    };
  }
}

/** Accept a registry or a plain list of addresses. */
export function toIncidentRegistry(
  input: Iterable<string> | IncidentRegistry | undefined,
): IncidentRegistry {
  if (input === undefined) return new StaticIncidentRegistry([], "none configured");
  if (
    typeof (input as IncidentRegistry).has === "function" &&
    typeof (input as IncidentRegistry).status === "function"
  ) {
    return input as IncidentRegistry;
  }
  return new StaticIncidentRegistry(input as Iterable<string>);
}
