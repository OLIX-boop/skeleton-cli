import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/util/lru.js';

describe('LruCache', () => {
  it('evicts the least recently used entries by count', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('evicts by total size and refuses oversized values', () => {
    const c = new LruCache<string, string>(100, 10, (v) => v.length);
    c.set('a', '12345');
    c.set('b', '12345');
    c.set('c', '1');
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(2);
    c.set('huge', 'x'.repeat(11));
    expect(c.get('huge')).toBeUndefined();
    c.set('b', '1');
    c.clear();
    expect(c.size).toBe(0);
  });
});
