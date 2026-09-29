import { describe, expect, it } from 'vitest';
import { outline } from '../src/engine/outline.js';
import { transformFile } from '../src/engine/transform.js';
import type { LanguageId } from '../src/index.js';

const o = async (src: string, lang: LanguageId) => (await outline(src, lang)).text;

describe('outline', () => {
  it('TypeScript: containers, members, signatures and type declarations', async () => {
    const src = `import x from 'x';

/** Docs. */
export interface User {
  id: string;
  greet(other: User): string;
}

export type Id = string | number;

export enum Role { Admin, User }

@Injectable()
export class UserService extends Base {
  private cache = new Map<string, User>();
  constructor(private readonly repo: Repo) {
    super();
  }
  async find(id: string): Promise<User | null> {
    const helper = () => 1;
    return null;
  }
  static create(): UserService { return new UserService(null!); }
}

export const handler = async (req: Request): Promise<Response> => {
  return new Response();
};

export function parse(input: string): number;
export function parse(input: string | Buffer): number {
  return 1;
}
`;
    expect(await o(src, 'typescript')).toBe(`export interface User
  id: string
  greet(other: User): string
export type Id = string | number
export enum Role { Admin, User }
export class UserService extends Base
  private cache = new Map<string, User>()
  constructor(private readonly repo: Repo)
  async find(id: string): Promise<User | null>
  static create(): UserService
export const handler = async (req: Request): Promise<Response> =>
export function parse(input: string): number
export function parse(input: string | Buffer): number
`);
  });

  it('Python: classes and methods with signatures', async () => {
    const src = `class User(Base):
    """Doc."""
    id: int

    def __init__(self, id: int) -> None:
        self.id = id

    @property
    def name(self) -> str:
        return "x"

async def main(argv: list[str] | None = None) -> int:
    return 0
`;
    expect(await o(src, 'python')).toBe(`class User(Base)
  def __init__(self, id: int) -> None
  def name(self) -> str
async def main(argv: list[str] | None = None) -> int
`);
  });

  it('Go, Rust (including same-line members), Java and C#', async () => {
    expect(
      await o('package x\n\ntype Store interface {\n\tGet(id string) error\n}\n\nfunc (s *mem) Get(id string) error {\n\treturn nil\n}\n', 'go'),
    ).toBe('type Store interface\nfunc (s *mem) Get(id string) error\n');
    expect(await o('pub struct S { a: i32 }\nimpl S {\n    pub fn new() -> Self { S { a: 1 } }\n}\ntrait T { fn m(&self); fn d(&self) {} }\n', 'rust')).toBe(
      'pub struct S { a: i32 }\nimpl S\n  pub fn new() -> Self\ntrait T\n  fn m(&self)\n  fn d(&self)\n',
    );
    expect(await o('public class A {\n  public A() {}\n  public int f(int x) { return x; }\n}\ninterface I { void m(); }\n', 'java')).toBe(
      'public class A\n  public A()\n  public int f(int x)\ninterface I\n  void m()\n',
    );
    expect(await o('namespace App {\n  public class A {\n    public int Id { get; set; }\n    public int F(int x) { return x; }\n  }\n}\n', 'csharp')).toBe(
      'namespace App\n  public class A\n    public int Id { get; set; }\n    public int F(int x)\n',
    );
  });

  it('Ruby, Elixir, Kotlin, Dart', async () => {
    expect(await o('module M\n  class A < B\n    def initialize(x)\n      @x = x\n    end\n    def self.build = new(1)\n  end\nend\n', 'ruby')).toBe(
      'module M\n  class A < B\n    def initialize(x)\n',
    );
    expect(await o('defmodule App.Users do\n  def get(id) do\n    Repo.get(id)\n  end\nend\n', 'elixir')).toBe('defmodule App.Users\n  def get(id)\n');
    expect(await o('class A(val x: Int) {\n    fun f(a: Int): Int {\n        return a\n    }\n}\ninterface I {\n    fun m()\n}\n', 'kotlin')).toBe(
      'class A(val x: Int)\n  fun f(a: Int): Int\ninterface I\n  fun m()\n',
    );
    expect(await o('class Counter {\n  int twice(int x) {\n    return x * 2;\n  }\n}\n', 'dart')).toBe('class Counter\n  int twice(int x)\n');
  });
});

describe('outline mode in transformFile', () => {
  it('produces outline content for code and truncates other files', async () => {
    const code = await transformFile('a.ts', 'export function f(a: number): number {\n  return a;\n}\n', { mode: 'outline' });
    expect(code).toMatchObject({ strategy: 'outline', content: 'export function f(a: number): number\n' });
    const vue = await transformFile('A.vue', '<script setup lang="ts">\nfunction inc(): void {\n  n++;\n}\n</script>\n<p/>\n', { mode: 'outline' });
    expect(vue).toMatchObject({ strategy: 'outline', content: 'function inc(): void\n' });
    const md = await transformFile('README.md', '# Hi\n', { mode: 'outline' });
    expect(md).toMatchObject({ strategy: 'full', content: '# Hi\n' });
  });
});

describe('outline edge cases', () => {
  it('ignores member-like nodes outside containers', async () => {
    const src = "export const VERSION: string = (require('../package.json') as { version: string }).version;\n";
    expect(await o(src, 'typescript')).toBe('');
  });

  it('falls back to the skeleton for files without declarations', async () => {
    const barrel = "export { a } from './a.js';\nexport * from './b.js';\n";
    const out = await transformFile('index.ts', barrel, { mode: 'outline' });
    expect(out).toMatchObject({ strategy: 'skeleton', content: barrel });
  });
});
