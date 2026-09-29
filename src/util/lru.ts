/** A small LRU cache bounded by entry count and by a caller-supplied size measure. */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxSize = Infinity,
    private readonly sizeOf: (value: V) => number = () => 1,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const size = this.sizeOf(value);
    if (size > this.maxSize) return;
    const existing = this.map.get(key);
    if (existing) {
      this.total -= existing.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    while (this.map.size > this.maxEntries || this.total > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.total -= this.map.get(oldest.value)!.size;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get size(): number {
    return this.map.size;
  }
}
