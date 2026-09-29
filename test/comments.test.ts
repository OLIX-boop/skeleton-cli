import { describe, expect, it } from 'vitest';
import { skeletonize, type LanguageId } from '../src/index.js';
import type { CommentMode } from '../src/languages/types.js';

async function run(src: string, lang: LanguageId, comments: CommentMode, bodies = true) {
  return skeletonize(src, lang, { comments, bodies });
}

describe('comment stripping', () => {
  const ts = `#!/usr/bin/env node
// Copyright 2024 Example Corp.

import { x } from './x'; // side-effect free

/**
 * Adds numbers.
 */
export function add(a: number, b: number): number {
  // inside the body
  return a + b;
}

// Attached line comment.
export const PI = 3.14; /* trailing block */

// Floating comment.

/* commented-out code
const old = 1;
*/
export interface Shape {
  /** Area in m². */
  area(): number; // trailing
}
`;

  it('keeps everything with comments=all', async () => {
    const out = await run(ts, 'typescript', 'all', false);
    expect(out.code).toBe(ts);
    expect(out.strippedComments).toBe(0);
  });

  it('keeps only documentation with comments=docs', async () => {
    const out = await run(ts, 'typescript', 'docs', false);
    expect(out.code).toBe(`#!/usr/bin/env node

import { x } from './x';

/**
 * Adds numbers.
 */
export function add(a: number, b: number): number {
  return a + b;
}

// Attached line comment.
export const PI = 3.14;


export interface Shape {
  /** Area in m². */
  area(): number;
}
`);
  });

  it('removes all comments except directives with comments=none', async () => {
    const out = await run(ts, 'typescript', 'none', false);
    expect(out.code).toBe(`#!/usr/bin/env node

import { x } from './x';

export function add(a: number, b: number): number {
  return a + b;
}

export const PI = 3.14;


export interface Shape {
  area(): number;
}
`);
    expect(out.strippedComments).toBe(10);
  });

  it('combines with body stripping', async () => {
    const out = await run(ts, 'typescript', 'docs');
    expect(out.code).toContain('export function add(a: number, b: number): number { /* ... */ }');
    expect(out.code).not.toContain('inside the body');
    expect(out.strippedBodies).toBe(1);
  });

  it('keeps Go build directives and attached doc comments', async () => {
    const src = `//go:build linux

// Package x does things.
package x

// Max is the limit.
const Max = 3

// stray note

func f() {}
`;
    const docs = await run(src, 'go', 'docs', false);
    expect(docs.code).toBe(`//go:build linux

// Package x does things.
package x

// Max is the limit.
const Max = 3


func f() {}
`);
    const none = await run(src, 'go', 'none', false);
    expect(none.code).toBe(`//go:build linux

package x

const Max = 3


func f() {}
`);
  });

  it('handles Rust doc comments', async () => {
    const src = `//! Crate docs.
/// Item docs.
pub struct S; // trailing
// plain
fn f() {}
`;
    expect((await run(src, 'rust', 'docs', false)).code).toBe(`//! Crate docs.
/// Item docs.
pub struct S;
// plain
fn f() {}
`);
    expect((await run(src, 'rust', 'none', false)).code).toBe(`pub struct S;
fn f() {}
`);
  });

  it('removes Python comments and docstrings with comments=none', async () => {
    const src = `"""Module docs."""
# -*- coding: utf-8 -*-
import os  # noqa

class Empty:
    """Only a docstring."""

class User:
    """A user."""
    # the id
    id: int

    def name(self) -> str:
        """The name."""
        return "x"

def f():
    """Docs."""
    return 1
`;
    const none = await run(src, 'python', 'none');
    expect(none.code).toBe(`# -*- coding: utf-8 -*-
import os  # noqa

class Empty:
    ...

class User:
    id: int

    def name(self) -> str:
        ...

def f():
    ...
`);
    expect(none.hasErrors).toBe(false);
    const reparsed = await skeletonize(none.code, 'python');
    expect(reparsed.hasErrors).toBe(false);

    const docs = await run(src, 'python', 'docs');
    expect(docs.code).toContain('"""Module docs."""');
    expect(docs.code).toContain('    """The name."""\n        ...'.replace('    """', '        """'));
    expect(docs.code).toContain('    # the id\n    id: int'); // attached to a declaration
  });

  it('strips Python docstrings without touching bodies in full mode', async () => {
    const src = 'def f():\n    """Docs."""\n    return 1\n\ndef g():\n    """Only docs."""\n';
    const out = await run(src, 'python', 'none', false);
    expect(out.code).toBe('def f():\n    return 1\n\ndef g():\n    ...\n');
  });

  it('produces parseable output for C-family languages', async () => {
    const cases: [LanguageId, string][] = [
      ['java', '/** Doc. */\nclass A {\n  // x\n  int f() { /* inner */ return 1; } // t\n}\n'],
      ['csharp', '/// <summary>Doc</summary>\nclass A {\n  // x\n  int F() { return 1; } // t\n}\n'],
      ['c', '/* header */\nint f(void) { return 1; } // t\n'],
      ['ruby', '# Doc\nclass A\n  # x\n  def f\n    1 # t\n  end\nend\n'],
      ['bash', '#!/bin/bash\n# doc\nf() {\n  echo 1 # t\n}\n'],
    ];
    for (const [lang, src] of cases) {
      const out = await run(src, lang, 'none', false);
      expect(out.hasErrors, lang).toBe(false);
      expect((await skeletonize(out.code, lang)).hasErrors, `${lang} reparse`).toBe(false);
      expect(out.strippedComments, lang).toBeGreaterThan(0);
    }
  });
});
