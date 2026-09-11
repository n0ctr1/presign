/**
 * A Map that forgets its least recently used entry past a fixed size.
 *
 * Every cache keyed by a counterparty grows with the addresses callers send,
 * and callers choose those addresses. An unbounded Map there is memory anyone
 * can fill for the price of a free quote request, so each such cache is
 * bounded, and the bound costs nothing but a repeated lookup for an address
 * nobody has asked about in a while.
 */
export class LruMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`an LRU map needs room for at least one entry, got ${maxEntries}`);
    }
    this.#maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    // Re-inserted so insertion order is recency order.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value as K);
    }
    return this;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}
