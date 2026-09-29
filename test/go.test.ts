import { describe, expect, it } from 'vitest';
import { expectValid, P, skel } from './helpers.js';

describe('Go', () => {
  const src = `// Package store persists things.
package store

import (
	"context"
	"errors"
)

// ErrNotFound is returned when an item is missing.
var ErrNotFound = errors.New("not found")

const MaxItems = 100

// Item is a stored value.
type Item struct {
	ID   string \`json:"id"\`
	Tags []string
}

type Store interface {
	Get(ctx context.Context, id string) (*Item, error)
	Put(ctx context.Context, it *Item) error
}

type memStore[K comparable, V any] struct {
	items map[K]V
}

// New creates a store.
func New() *memStore[string, *Item] {
	return &memStore[string, *Item]{items: map[string]*Item{}}
}

func (m *memStore[K, V]) Get(ctx context.Context, id K) (V, error) {
	v, ok := m.items[id]
	if !ok {
		var zero V
		return zero, ErrNotFound
	}
	return v, nil
}

var handler = func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}

func init() {}
`;

  it('strips function, method and literal bodies but keeps types and declarations', async () => {
    expect(await skel(src, 'go')).toBe(`// Package store persists things.
package store

import (
	"context"
	"errors"
)

// ErrNotFound is returned when an item is missing.
var ErrNotFound = errors.New("not found")

const MaxItems = 100

// Item is a stored value.
type Item struct {
	ID   string \`json:"id"\`
	Tags []string
}

type Store interface {
	Get(ctx context.Context, id string) (*Item, error)
	Put(ctx context.Context, it *Item) error
}

type memStore[K comparable, V any] struct {
	items map[K]V
}

// New creates a store.
func New() *memStore[string, *Item] ${P}

func (m *memStore[K, V]) Get(ctx context.Context, id K) (V, error) ${P}

var handler = func(w http.ResponseWriter, r *http.Request) ${P}

func init() ${P}
`);
  });

  it('produces valid, idempotent output', async () => {
    const result = await expectValid(src, 'go');
    expect(result.strippedBodies).toBe(4);
  });
});
