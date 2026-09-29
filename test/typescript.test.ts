import { describe, expect, it } from 'vitest';
import { languageForPath, skeletonize, type LanguageId } from '../src/index.js';
import { expectValid as expectValidIn, P, skel as skelIn } from './helpers.js';

async function skel(source: string, lang: LanguageId = 'typescript') {
  return skelIn(source, lang);
}

async function expectValid(source: string, lang: LanguageId = 'typescript') {
  return expectValidIn(source, lang);
}

describe('TypeScript functions', () => {
  it('strips function bodies but keeps full signatures', async () => {
    const src = `export async function fetchUser<T extends { id: string }>(
  id: string,
  opts: RequestInit = {},
): Promise<T | undefined> {
  const res = await fetch(\`/users/\${id}\`, opts);
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}
`;
    expect(await skel(src)).toBe(`export async function fetchUser<T extends { id: string }>(
  id: string,
  opts: RequestInit = {},
): Promise<T | undefined> ${P}
`);
  });

  it('strips generator functions and function expressions', async () => {
    const src = `function* ids(): Generator<number> { let i = 0; while (true) yield i++; }
const handler = function named(e: Event): void { console.log(e); };
`;
    expect(await skel(src)).toBe(`function* ids(): Generator<number> ${P}
const handler = function named(e: Event): void ${P};
`);
  });

  it('keeps overload signatures and strips only the implementation', async () => {
    const src = `export function parse(input: string): number;
export function parse(input: Buffer): number;
export function parse(input: string | Buffer): number {
  return Number(input.toString());
}
`;
    expect(await skel(src)).toBe(`export function parse(input: string): number;
export function parse(input: Buffer): number;
export function parse(input: string | Buffer): number ${P}
`);
  });

  it('strips block-bodied arrows and multi-line expression arrows, keeps one-liners', async () => {
    const src = `export const double = (x: number): number => x * 2;
export const load = async (id: string): Promise<void> => {
  await db.load(id);
};
export const Query = (q: string) =>
  db
    .select()
    .where(q);
`;
    expect(await skel(src)).toBe(`export const double = (x: number): number => x * 2;
export const load = async (id: string): Promise<void> => ${P};
export const Query = (q: string) => ${P};
`);
  });

  it('strips nested closures together with their enclosing body', async () => {
    const src = `function outer() {
  const inner = () => { return 1; };
  return function deeper() { return inner(); };
}
`;
    const result = await skeletonize(src, 'typescript');
    expect(result.code).toBe(`function outer() ${P}\n`);
    expect(result.strippedBodies).toBe(1);
  });

  it('strips closures in default parameter values', async () => {
    const src = `export function run(cb: () => void = () => { noop(); }) { cb(); }\n`;
    expect(await skel(src)).toBe(`export function run(cb: () => void = () => ${P}) ${P}\n`);
  });

  it('strips closures passed to top-level calls', async () => {
    const src = `app.get('/health', async (req, res) => {
  res.send('ok');
});
`;
    expect(await skel(src)).toBe(`app.get('/health', async (req, res) => ${P});\n`);
  });
});

describe('TypeScript classes', () => {
  const src = `import { Injectable, Inject } from '@nestjs/common';
import type { Repo } from './repo';

/**
 * Service responsible for users.
 */
@Injectable({ scope: 'request' })
export class UserService<T extends Entity = User> extends BaseService implements OnInit {
  static readonly VERSION = 2;
  private cache = new Map<string, T>();
  #secret: string;
  @Inject('LOGGER') private readonly logger!: Logger;

  static {
    UserService.registry.add(this);
  }

  constructor(
    @Inject(REPO) private readonly repo: Repo<T>,
    public name: string,
  ) {
    super();
    this.#secret = 'x';
  }

  /** Find a user by id. */
  @Cacheable({ ttl: 60 })
  async find(@Param('id') id: string): Promise<T | null> {
    return this.cache.get(id) ?? this.repo.findOne(id);
  }

  get size(): number {
    return this.cache.size;
  }

  set size(value: number) {
    throw new Error('readonly');
  }

  #hash(input: string): string {
    return input.split('').reverse().join('');
  }

  onClick = (e: MouseEvent): void => {
    this.logger.log(e);
  };

  protected abstract validate(user: T): boolean;

  toString(): string;
}
`;

  it('keeps decorators, fields, modifiers and signatures, strips member bodies', async () => {
    expect(await skel(src)).toBe(`import { Injectable, Inject } from '@nestjs/common';
import type { Repo } from './repo';

/**
 * Service responsible for users.
 */
@Injectable({ scope: 'request' })
export class UserService<T extends Entity = User> extends BaseService implements OnInit {
  static readonly VERSION = 2;
  private cache = new Map<string, T>();
  #secret: string;
  @Inject('LOGGER') private readonly logger!: Logger;

  static ${P}

  constructor(
    @Inject(REPO) private readonly repo: Repo<T>,
    public name: string,
  ) ${P}

  /** Find a user by id. */
  @Cacheable({ ttl: 60 })
  async find(@Param('id') id: string): Promise<T | null> ${P}

  get size(): number ${P}

  set size(value: number) ${P}

  #hash(input: string): string ${P}

  onClick = (e: MouseEvent): void => ${P};

  protected abstract validate(user: T): boolean;

  toString(): string;
}
`);
  });

  it('produces valid, idempotent output', async () => {
    const result = await expectValid(src);
    expect(result.strippedBodies).toBe(7);
  });

  it('strips methods inside object literals', async () => {
    const src = `export const api = {
  base: '/api',
  get(path: string) { return fetch(this.base + path); },
  post: async (path: string, body: unknown) => { return send(path, body); },
};
`;
    expect(await skel(src)).toBe(`export const api = {
  base: '/api',
  get(path: string) ${P},
  post: async (path: string, body: unknown) => ${P},
};
`);
  });
});

describe('TypeScript declarations are preserved verbatim', () => {
  it('leaves interfaces, types, enums, namespaces and ambient declarations untouched', async () => {
    const src = `export interface User {
  id: string;
  /** Display name */
  name?: string;
  greet(other: User): string;
  readonly [key: string]: unknown;
}

export type Handler<E = Event> = (event: E) => void | Promise<void>;
export type Mapped<T> = { [K in keyof T]-?: T[K] extends Function ? never : T[K] };

export enum Role {
  Admin = 'admin',
  User = 'user',
}

export const enum Flags { A = 1 << 0, B = 1 << 1 }

declare module 'express' {
  interface Request { user?: User }
}

declare function ambient(x: number): string;

export namespace Utils {
  export const VERSION = '1.0';
  export function helper(): void {
    doWork();
  }
}

export abstract class Shape {
  abstract area(): number;
}

export { Role as Roles };
export * from './other';
export default Utils;
`;
    const out = await skel(src);
    // Only the namespace function body changes.
    expect(out).toBe(
      src.replace(`export function helper(): void {\n    doWork();\n  }`, `export function helper(): void ${P}`),
    );
    await expectValid(src);
  });

  it('preserves comments and JSDoc outside bodies and drops comments inside them', async () => {
    const src = `// file header
/**
 * Adds numbers.
 * @param a first
 */
export function add(a: number, b: number): number {
  // internal comment
  return a + b;
}
`;
    expect(await skel(src)).toBe(`// file header
/**
 * Adds numbers.
 * @param a first
 */
export function add(a: number, b: number): number ${P}
`);
  });
});

describe('TSX and JavaScript', () => {
  it('strips React component bodies in TSX while keeping props types', async () => {
    const src = `import React, { useState } from 'react';

interface Props { title: string; onSave?: (v: string) => void }

export function Editor({ title, onSave }: Props): JSX.Element {
  const [v, setV] = useState('');
  return <div onClick={() => onSave?.(v)}>{title}</div>;
}

export const Badge: React.FC<{ n: number }> = ({ n }) => (
  <span className="badge">{n}</span>
);
`;
    expect(await skel(src, 'tsx')).toBe(`import React, { useState } from 'react';

interface Props { title: string; onSave?: (v: string) => void }

export function Editor({ title, onSave }: Props): JSX.Element ${P}

export const Badge: React.FC<{ n: number }> = ({ n }) => ${P};
`);
    await expectValid(src, 'tsx');
  });

  it('handles plain JavaScript with classes, JSX and CommonJS', async () => {
    const src = `const path = require('path');

class Store {
  constructor(items) { this.items = items; }
  static create() { return new Store([]); }
  *[Symbol.iterator]() { yield* this.items; }
}

function App() {
  return <main>{path.sep}</main>;
}

module.exports = { Store, App, id: (x) => x };
`;
    expect(await skel(src, 'javascript')).toBe(`const path = require('path');

class Store {
  constructor(items) ${P}
  static create() ${P}
  *[Symbol.iterator]() ${P}
}

function App() ${P}

module.exports = { Store, App, id: (x) => x };
`);
    await expectValid(src, 'javascript');
  });
});

describe('options and diagnostics', () => {
  it('supports a custom placeholder', async () => {
    const out = await skeletonize('function f() { return 1; }', 'typescript', {
      placeholder: '... omitted ...',
    });
    expect(out.code).toBe('function f() { /* ... omitted ... */ }');
  });

  it('handles non-ASCII source text correctly', async () => {
    const src = `const s = "héllo 🎉";\nfunction f(): string { return "ünïcödé 🚀"; }\nconst t = "✓";\n`;
    expect(await skel(src)).toBe(`const s = "héllo 🎉";\nfunction f(): string ${P}\nconst t = "✓";\n`);
  });

  it('reports syntax errors but still returns best-effort output', async () => {
    const result = await skeletonize('function ok() { return 1; }\nfunction broken( {', 'typescript');
    expect(result.hasErrors).toBe(true);
    expect(result.code.startsWith(`function ok() ${P}`)).toBe(true);
  });

  it('returns empty output for empty input', async () => {
    expect(await skeletonize('', 'typescript')).toEqual({ code: '', strippedBodies: 0, strippedComments: 0, hasErrors: false });
  });
});

describe('languageForPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/A.TSX', 'tsx'],
    ['a.js', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.cjs', 'javascript'],
  ])('%s -> %s', (file, id) => {
    expect(languageForPath(file)?.id).toBe(id);
  });

  it('returns undefined for unsupported files', () => {
    expect(languageForPath('README.md')).toBeUndefined();
    expect(languageForPath('Makefile')).toBeUndefined();
  });
});
