import { describe, expect, it } from 'vitest';
import { languageForPath, skeletonize, type LanguageId } from '../src/index.js';
import { expectValid, P, skel } from './helpers.js';

interface Case {
  lang: LanguageId;
  src: string;
  out: string;
  stripped: number;
  /** Some older grammars flag valid modern syntax; skip the re-parse check for those. */
  skipValidity?: boolean;
}

const cases: Record<string, Case> = {
  java: {
    lang: 'java',
    src: `package app;

import java.util.List;

/** A service. */
@Service
public class UserService extends Base implements Api {
    private final Repo repo;
    public static final int MAX = 10;

    static {
        System.loadLibrary("x");
    }

    {
        init();
    }

    public UserService(Repo repo) {
        this.repo = repo;
    }

    @Override
    public List<User> find(String q) throws IOException {
        return repo.search(q);
    }

    protected abstract void validate(User u);

    private final Runnable task = () -> {
        run();
    };
}

interface Api {
    List<User> find(String q) throws IOException;
    default int limit() {
        return 10;
    }
}

record Point(int x, int y) {
    Point {
        if (x < 0) throw new IllegalArgumentException();
    }
}

enum Color {
    RED, GREEN;
    Color next() {
        return values()[(ordinal() + 1) % 2];
    }
}
`,
    out: `package app;

import java.util.List;

/** A service. */
@Service
public class UserService extends Base implements Api {
    private final Repo repo;
    public static final int MAX = 10;

    static ${P}

    ${P}

    public UserService(Repo repo) ${P}

    @Override
    public List<User> find(String q) throws IOException ${P}

    protected abstract void validate(User u);

    private final Runnable task = () -> ${P};
}

interface Api {
    List<User> find(String q) throws IOException;
    default int limit() ${P}
}

record Point(int x, int y) {
    Point ${P}
}

enum Color {
    RED, GREEN;
    Color next() ${P}
}
`,
    stripped: 8,
  },
  csharp: {
    lang: 'csharp',
    src: `using System;

namespace App;

[Serializable]
public class User : Entity, IUser
{
    private readonly string _name;
    public int Id { get; init; }
    public string Name
    {
        get { return _name; }
        set { _name = value?.Trim(); }
    }
    public string Short => Name[..3];
    public string Long =>
        string.Join(",",
            Tags);

    public User(string name)
    {
        _name = name;
    }

    ~User() { Dispose(); }

    public async Task<int> SaveAsync(CancellationToken ct = default)
    {
        await db.SaveAsync(ct);
        return 1;
    }

    public static User operator +(User a, User b) { return a; }

    public int Twice(int x) => x * 2;
}

public interface IUser
{
    int Id { get; }
    Task<int> SaveAsync(CancellationToken ct = default);
}

public record Point(int X, int Y);
`,
    out: `using System;

namespace App;

[Serializable]
public class User : Entity, IUser
{
    private readonly string _name;
    public int Id { get; init; }
    public string Name
    {
        get ${P}
        set ${P}
    }
    public string Short => Name[..3];
    public string Long => default /* ... */;

    public User(string name)
    ${P}

    ~User() ${P}

    public async Task<int> SaveAsync(CancellationToken ct = default)
    ${P}

    public static User operator +(User a, User b) ${P}

    public int Twice(int x) => x * 2;
}

public interface IUser
{
    int Id { get; }
    Task<int> SaveAsync(CancellationToken ct = default);
}

public record Point(int X, int Y);
`,
    stripped: 7,
  },
  c: {
    lang: 'c',
    src: `#include <stdio.h>
#define MAX 10

typedef struct {
    int x, y;
} point_t;

static int helper(int a);

/* Adds numbers. */
int add(int a, int b) {
    return a + b;
}

static int helper(int a)
{
    for (int i = 0; i < a; i++) {
        printf("%d", i);
    }
    return 0;
}
`,
    out: `#include <stdio.h>
#define MAX 10

typedef struct {
    int x, y;
} point_t;

static int helper(int a);

/* Adds numbers. */
int add(int a, int b) ${P}

static int helper(int a)
${P}
`,
    stripped: 2,
  },
  cpp: {
    lang: 'cpp',
    src: `#include <vector>

namespace geo {

template <typename T>
class Shape {
public:
    explicit Shape(T size) : size_(size) {
        validate();
    }
    virtual ~Shape() = default;
    virtual double area() const = 0;
    T size() const { return size_; }

private:
    T size_;
};

double Circle::area() const {
    return 3.14 * r * r;
}

auto square = [](int x) {
    return x * x;
};

}  // namespace geo
`,
    out: `#include <vector>

namespace geo {

template <typename T>
class Shape {
public:
    explicit Shape(T size) : size_(size) ${P}
    virtual ~Shape() = default;
    virtual double area() const = 0;
    T size() const ${P}

private:
    T size_;
};

double Circle::area() const ${P}

auto square = [](int x) ${P};

}  // namespace geo
`,
    stripped: 4,
  },
  ruby: {
    lang: 'ruby',
    src: `require "json"

# A user.
class User < ApplicationRecord
  include Comparable
  attr_reader :name
  has_many :posts, dependent: :destroy
  MAX = 3

  def initialize(name)
    @name = name
  rescue ArgumentError
    nil
  end

  def self.find_by_email(email)
    where(email: email).first
  end

  def admin? = role == "admin"

  def to_s; name; end

  private

  def secret
    "x"
  end
end
`,
    out: `require "json"

# A user.
class User < ApplicationRecord
  include Comparable
  attr_reader :name
  has_many :posts, dependent: :destroy
  MAX = 3

  def initialize(name)
    # ...
  end

  def self.find_by_email(email)
    # ...
  end

  def admin? = role == "admin"

  def to_s; "..." end

  private

  def secret
    # ...
  end
end
`,
    stripped: 4,
  },
  php: {
    lang: 'php',
    src: `<?php
declare(strict_types=1);

namespace App\\Service;

use App\\Repo;

#[Attribute]
final class UserService implements Api
{
    private const LIMIT = 10;

    public function __construct(private Repo $repo)
    {
        $this->init();
    }

    public function find(string $q): array
    {
        return $this->repo->search($q);
    }

    abstract protected function validate(User $u): bool;
}

function helper(int $a): int {
    return $a * 2;
}

$double = fn($x) => $x * 2;
$cb = function ($x) use ($y) {
    return $x + $y;
};
`,
    out: `<?php
declare(strict_types=1);

namespace App\\Service;

use App\\Repo;

#[Attribute]
final class UserService implements Api
{
    private const LIMIT = 10;

    public function __construct(private Repo $repo)
    ${P}

    public function find(string $q): array
    ${P}

    abstract protected function validate(User $u): bool;
}

function helper(int $a): int ${P}

$double = fn($x) => $x * 2;
$cb = function ($x) use ($y) ${P};
`,
    stripped: 4,
  },
  kotlin: {
    lang: 'kotlin',
    src: `package app

import kotlinx.coroutines.flow.Flow

/** A user. */
data class User(val id: Long, val name: String)

class UserService(private val repo: Repo) : Api {
    init {
        require(repo.ready)
    }

    constructor(url: String) : this(Repo(url)) {
        log("created")
    }

    val count: Int
        get() {
            return repo.size()
        }

    override suspend fun find(q: String): List<User> {
        return repo.search(q)
    }

    fun twice(x: Int) = x * 2

    fun describe(u: User) =
        buildString {
            append(u.name)
        }
}

interface Api {
    suspend fun find(q: String): List<User>
}
`,
    out: `package app

import kotlinx.coroutines.flow.Flow

/** A user. */
data class User(val id: Long, val name: String)

class UserService(private val repo: Repo) : Api {
    init ${P}

    constructor(url: String) : this(Repo(url)) ${P}

    val count: Int
        get() ${P}

    override suspend fun find(q: String): List<User> ${P}

    fun twice(x: Int) = x * 2

    fun describe(u: User) = TODO() /* ... */
}

interface Api {
    suspend fun find(q: String): List<User>
}
`,
    stripped: 5,
  },
  swift: {
    lang: 'swift',
    src: `import Foundation

/// A user.
struct User: Codable {
    let id: Int
    var name: String

    var display: String {
        return "\\(name) (\\(id))"
    }

    init(id: Int, name: String) {
        self.id = id
        self.name = name
    }

    func greet(_ other: User) -> String {
        return "Hi \\(other.name)"
    }
}

protocol Store {
    func load(id: Int) async throws -> User
}

final class Cache {
    deinit {
        print("bye")
    }
}
`,
    out: `import Foundation

/// A user.
struct User: Codable {
    let id: Int
    var name: String

    var display: String { /* ... */ }

    init(id: Int, name: String) ${P}

    func greet(_ other: User) -> String ${P}
}

protocol Store {
    func load(id: Int) async throws -> User
}

final class Cache {
    deinit ${P}
}
`,
    stripped: 4,
  },
  scala: {
    lang: 'scala',
    src: `package app

case class User(id: Long, name: String)

trait Repo {
  def find(id: Long): Option[User]
}

class Service(repo: Repo) {
  def load(id: Long): User = {
    repo.find(id).getOrElse(throw new Exception("missing"))
  }

  def twice(x: Int): Int = x * 2

  def describe(u: User): String =
    s"\${u.name}" +
      s"(\${u.id})"
}
`,
    out: `package app

case class User(id: Long, name: String)

trait Repo {
  def find(id: Long): Option[User]
}

class Service(repo: Repo) {
  def load(id: Long): User = ${P}

  def twice(x: Int): Int = x * 2

  def describe(u: User): String =
    ${P}
}
`,
    stripped: 2,
  },
  dart: {
    lang: 'dart',
    src: `import 'package:flutter/material.dart';

class Counter extends StatefulWidget {
  final int start;
  const Counter({super.key, this.start = 0});

  int twice(int x) => x * 2;

  @override
  State<Counter> createState() {
    return _CounterState();
  }
}

void main() {
  runApp(const Counter());
}
`,
    out: `import 'package:flutter/material.dart';

class Counter extends StatefulWidget {
  final int start;
  const Counter({super.key, this.start = 0});

  int twice(int x) => x * 2;

  @override
  State<Counter> createState() ${P}
}

void main() ${P}
`,
    stripped: 2,
  },
  elixir: {
    lang: 'elixir',
    src: `defmodule App.Users do
  @moduledoc "Users."
  use Ecto.Schema
  alias App.Repo

  @doc "Fetch a user."
  @spec get(integer()) :: User.t() | nil
  def get(id) do
    Repo.get(User, id)
    |> preload()
  end

  def name(%User{name: n}), do: n

  defp preload(user) do
    Repo.preload(user, :posts)
  end
end
`,
    out: `defmodule App.Users do
  @moduledoc "Users."
  use Ecto.Schema
  alias App.Repo

  @doc "Fetch a user."
  @spec get(integer()) :: User.t() | nil
  def get(id) do
    # ...
  end

  def name(%User{name: n}), do: n

  defp preload(user) do
    # ...
  end
end
`,
    stripped: 2,
  },
  bash: {
    lang: 'bash',
    src: `#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0"

# Print usage.
usage() {
  echo "usage: $0 <cmd>"
  exit 1
}

function deploy {
  rsync -a dist/ server:/srv
}

main "$@"
`,
    out: `#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0"

# Print usage.
usage() { : '...'; }

function deploy { : '...'; }

main "$@"
`,
    stripped: 2,
  },
  lua: {
    lang: 'lua',
    src: `local M = {}

--- Adds two numbers.
local function add(a, b)
  return a + b
end

function M.greet(name)
  print("hi " .. name)
end

function M:method(x) return x end

local cb = function(x)
  return x * 2
end

return M
`,
    out: `local M = {}

--- Adds two numbers.
local function add(a, b)
  --[[ ... ]]
end

function M.greet(name)
  --[[ ... ]]
end

function M:method(x) --[[ ... ]] end

local cb = function(x)
  --[[ ... ]]
end

return M
`,
    stripped: 4,
  },
  zig: {
    lang: 'zig',
    src: `const std = @import("std");
/// A point.
pub const Point = struct {
    x: i32,
    y: i32,
    pub fn add(self: Point, other: Point) Point {
        return .{ .x = self.x + other.x, .y = self.y + other.y };
    }
};
pub fn main() !void {
    const p = Point{ .x = 1, .y = 2 };
    std.debug.print("{}\\n", .{p});
}
test "add" {
    try std.testing.expect(true);
}
const E = enum { a, b };
const U = union(enum) { x: i32, y: void };
pub fn generic(comptime T: type) type {
    return struct {
        value: T,
        pub fn get(self: @This()) T {
            return self.value;
        }
    };
}
comptime {
    _ = 1;
}
test "x" {
    _ = 2;
}
fn cb() void {
    const f = struct {
        fn inner() void {}
    }.inner;
    _ = f;
}
`,
    out: `const std = @import("std");
/// A point.
pub const Point = struct {
    x: i32,
    y: i32,
    pub fn add(self: Point, other: Point) Point {
        // ...
    }
};
pub fn main() !void {
    // ...
}
test "add" {
    // ...
}
const E = enum { a, b };
const U = union(enum) { x: i32, y: void };
pub fn generic(comptime T: type) type {
    return struct {
        value: T,
        pub fn get(self: @This()) T {
            // ...
        }
    };
}
comptime {
    // ...
}
test "x" {
    // ...
}
fn cb() void {
    // ...
}
`,
    stripped: 7,
  },
  solidity: {
    lang: 'solidity',
    src: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./IERC20.sol";
/// @title Token
contract Token is IERC20 {
    mapping(address => uint256) private balances;
    event Moved(address indexed from, uint256 amount);
    modifier onlyOwner() {
        require(msg.sender == owner, "no");
        _;
    }
    constructor(uint256 supply) {
        balances[msg.sender] = supply;
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        balances[msg.sender] -= amount;
        return true;
    }
    function total() external view virtual returns (uint256);
    receive() external payable {}
    fallback() external { revert(); }
}
interface IFoo { function foo() external; }
library L { function f(uint x) internal pure returns (uint) { return x; } }
`,
    out: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./IERC20.sol";
/// @title Token
contract Token is IERC20 {
    mapping(address => uint256) private balances;
    event Moved(address indexed from, uint256 amount);
    modifier onlyOwner() { /* ... */ }
    constructor(uint256 supply) { /* ... */ }
    function transfer(address to, uint256 amount) external override returns (bool) { /* ... */ }
    function total() external view virtual returns (uint256);
    receive() external payable {}
    fallback() external { /* ... */ }
}
interface IFoo { function foo() external; }
library L { function f(uint x) internal pure returns (uint) { /* ... */ } }
`,
    stripped: 5,
  },
  haskell: {
    lang: 'haskell',
    src: `module Data.Stack (Stack, push, pop) where

import qualified Data.Map as M

-- | A stack.
data Stack a = Stack [a] deriving (Show)

class Container f where
  empty :: f a
  insert :: a -> f a -> f a

instance Container Stack where
  empty = Stack []
  insert x (Stack xs) = Stack (x : xs)

-- | Push an element.
push :: a -> Stack a -> Stack a
push x (Stack xs) = Stack (x : xs)

pop :: Stack a -> Maybe (a, Stack a)
pop (Stack []) = Nothing
pop (Stack (x : xs)) =
  let rest = Stack xs
   in Just (x, rest)

main :: IO ()
main = do
  print (push 1 (Stack []))
  putStrLn "done"
`,
    out: `module Data.Stack (Stack, push, pop) where

import qualified Data.Map as M

-- | A stack.
data Stack a = Stack [a] deriving (Show)

class Container f where
  empty :: f a
  insert :: a -> f a -> f a

instance Container Stack where
  empty = Stack []
  insert x (Stack xs) = Stack (x : xs)

-- | Push an element.
push :: a -> Stack a -> Stack a
push x (Stack xs) = Stack (x : xs)

pop :: Stack a -> Maybe (a, Stack a)
pop (Stack []) = Nothing
pop (Stack (x : xs)) = undefined {- ... -}

main :: IO ()
main = undefined {- ... -}
`,
    stripped: 2,
  },
  ocaml: {
    lang: 'ocaml',
    src: `(** A stack module. *)
module Stack = struct
  type 'a t = 'a list

  let empty = []

  (** Push. *)
  let push x s =
    let y = x in
    y :: s

  let rec length = function
    | [] -> 0
    | _ :: t -> 1 + length t
end

module type S = sig
  type t
  val f : t -> int
end

let main () =
  print_endline "hi";
  ignore (Stack.push 1 Stack.empty)

class point x_init = object
  val mutable x = x_init
  method get_x = x
  method move d = x <- x + d
end
`,
    out: `(** A stack module. *)
module Stack = struct
  type 'a t = 'a list

  let empty = []

  (** Push. *)
  let push x s =
    assert false (* ... *)

  let rec length = assert false (* ... *)
end

module type S = sig
  type t
  val f : t -> int
end

let main () =
  assert false (* ... *)

class point x_init = object
  val mutable x = x_init
  method get_x = x
  method move d = x <- x + d
end
`,
    stripped: 3,
  },
  julia: {
    lang: 'julia',
    src: `module Geometry
export Point, norm2
using LinearAlgebra

"""
    Point(x, y)

A 2D point.
"""
struct Point{T<:Real}
    x::T
    y::T
end

abstract type Shape end

function norm2(p::Point)::Float64
    s = p.x^2 + p.y^2
    return sqrt(s)
end

area(r::Float64) = pi * r^2

macro twice(ex)
    quote
        $(esc(ex)); $(esc(ex))
    end
end

f = x -> begin
    x + 1
end
end
`,
    out: `module Geometry
export Point, norm2
using LinearAlgebra

"""
    Point(x, y)

A 2D point.
"""
struct Point{T<:Real}
    x::T
    y::T
end

abstract type Shape end

function norm2(p::Point)::Float64 #= ... =# end

area(r::Float64) = pi * r^2

macro twice(ex) #= ... =# end

f = x -> begin
    x + 1
end
end
`,
    stripped: 2,
  },
  objc: {
    lang: 'objc',
    src: `#import <Foundation/Foundation.h>
#import "Stack.h"

/// A stack.
@interface Stack : NSObject
@property (nonatomic, strong) NSMutableArray *items;
- (void)push:(id)item;
+ (instancetype)stack;
@end

@implementation Stack
- (void)push:(id)item {
    [self.items addObject:item];
}
+ (instancetype)stack {
    return [[self alloc] init];
}
@end

static int helper(int x) {
    return x * 2;
}

void (^block)(int) = ^(int n) {
    NSLog(@"%d", n);
};
`,
    out: `#import <Foundation/Foundation.h>
#import "Stack.h"

/// A stack.
@interface Stack : NSObject
@property (nonatomic, strong) NSMutableArray *items;
- (void)push:(id)item;
+ (instancetype)stack;
@end

@implementation Stack
- (void)push:(id)item { /* ... */ }
+ (instancetype)stack { /* ... */ }
@end

static int helper(int x) { /* ... */ }

void (^block)(int) = ^(int n) { /* ... */ };
`,
    stripped: 4,
  },
};

describe.each(Object.entries(cases))('%s', (_name, c) => {
  it('strips bodies and keeps declarations', async () => {
    const result = await skeletonize(c.src, c.lang);
    expect(result.code).toBe(c.out);
    expect(result.strippedBodies).toBe(c.stripped);
  });

  it.skipIf(!!c.skipValidity)('produces valid, idempotent output', async () => {
    await expectValid(c.src, c.lang);
  });
});

describe('languageForPath (all languages)', () => {
  it.each([
    ['A.java', 'java'],
    ['Program.cs', 'csharp'],
    ['main.c', 'c'],
    ['util.h', 'c'],
    ['main.cpp', 'cpp'],
    ['vec.hpp', 'cpp'],
    ['app.rb', 'ruby'],
    ['tasks.rake', 'ruby'],
    ['index.php', 'php'],
    ['Main.kt', 'kotlin'],
    ['build.gradle.kts', 'kotlin'],
    ['App.swift', 'swift'],
    ['Main.scala', 'scala'],
    ['main.dart', 'dart'],
    ['users.ex', 'elixir'],
    ['mix.exs', 'elixir'],
    ['deploy.sh', 'bash'],
    ['init.lua', 'lua'],
    ['main.zig', 'zig'],
    ['Token.sol', 'solidity'],
    ['Main.hs', 'haskell'],
    ['stack.ml', 'ocaml'],
    ['stack.mli', 'ocaml_interface'],
    ['geometry.jl', 'julia'],
    ['AppDelegate.m', 'objc'],
    ['View.mm', 'objc'],
  ])('%s -> %s', (file, id) => {
    expect(languageForPath(file)?.id).toBe(id);
  });
});

describe('custom placeholders', () => {
  it('wraps the marker for each syntax', async () => {
    const opts = { placeholder: 'omitted' };
    expect((await skeletonize('def f\n  1\nend\n', 'ruby', opts)).code).toBe('def f\n  # omitted\nend\n');
    expect((await skeletonize('object O {\n  def f: Int = {\n    1\n  }\n}\n', 'scala', opts)).code).toContain('def f: Int = { /* omitted */ }');
    expect((await skeletonize("f() {\n  echo 'x'\n}\n", 'bash', { placeholder: "it's" })).code).toBe("f() { : 'its'; }\n");
  });

  it('keeps skel() helper in sync', async () => {
    expect(await skel('int f() { return 1; }', 'c')).toBe(`int f() ${P}`);
  });
});

describe('test suites keep their structure', () => {
  it('keeps describe blocks and test names in JS/TS', async () => {
    const src = `describe('User', () => {
  beforeEach(() => {
    db.reset();
  });

  it('validates emails', async () => {
    expect(await validate('x')).toBe(false);
  });

  describe.each([1, 2])('with %i', (n) => {
    test('doubles', () => {
      expect(n * 2).toBe(n + n);
    });
  });
});
`;
    expect(await skel(src, 'typescript')).toBe(`describe('User', () => {
  beforeEach(() => ${P});

  it('validates emails', async () => ${P});

  describe.each([1, 2])('with %i', (n) => {
    test('doubles', () => ${P});
  });
});
`);
  });

  it('keeps RSpec describe/context and strips example bodies', async () => {
    const src = `RSpec.describe User do
  let(:user) { build(:user) }

  before do
    setup!
  end

  context "when admin" do
    it "can delete" do
      expect(user.can?(:delete)).to be true
    end

    it("is short") { expect(1).to eq 1 }
  end
end
`;
    expect(await skel(src, 'ruby')).toBe(`RSpec.describe User do
  let(:user) { build(:user) }

  before do
    # ...
  end

  context "when admin" do
    it "can delete" do
      # ...
    end

    it("is short") { "..." }
  end
end
`);
  });

  it('strips ExUnit test bodies inside describe blocks', async () => {
    const src = `defmodule UserTest do
  use ExUnit.Case

  setup do
    {:ok, user: build()}
  end

  describe "create/1" do
    test "inserts", %{user: user} do
      assert {:ok, _} = create(user)
    end
  end
end
`;
    expect(await skel(src, 'elixir')).toBe(`defmodule UserTest do
  use ExUnit.Case

  setup do
    # ...
  end

  describe "create/1" do
    test "inserts", %{user: user} do
      # ...
    end
  end
end
`);
  });
});

describe('C# lambdas and anonymous methods', () => {
  it('strips block and multi-line lambdas, keeps one-liners', async () => {
    const src = `class A {
    Func<int, int> f = x => x * 2;
    Action a = () => {
        Run();
    };
    Func<int, int> g = x =>
        x
        + 1;
    EventHandler h = delegate (object s, EventArgs e) { Log(); };
}
`;
    const out = await skel(src, 'csharp');
    expect(out).toContain('Func<int, int> f = x => x * 2;');
    expect(out).toContain(`Action a = () => ${P};`);
    expect(out).toContain(`Func<int, int> g = x =>\n        ${P};`);
    expect(out).toContain(`delegate (object s, EventArgs e) ${P};`);
  });
});

describe('C# preprocessor directives', () => {
  it('parses #if branches that split a declaration header', async () => {
    const src = `namespace N {
#if NETSTANDARD
    public sealed class A : IDisposable
#else
    public sealed class A : IAsyncDisposable
#endif
    {
        #region Api
        public void F()
        {
#if DEBUG
            if (verbose) {
#endif
            Run();
#if DEBUG
            }
#endif
        }
        #endregion
        public int G() => 1;
    }
}
`;
    const result = await skeletonize(src, 'csharp');
    expect(result.hasErrors).toBe(false);
    expect(result.code).toBe(`namespace N {
#if NETSTANDARD
    public sealed class A : IDisposable
#else
    public sealed class A : IAsyncDisposable
#endif
    {
        #region Api
        public void F()
        ${P}
        #endregion
        public int G() => 1;
    }
}
`);
  });

  it('strips bodies in every branch of a chain, nested chains included', async () => {
    const src = `class A
#if NET8_0
    : IA
#elif NET6_0
    : IB
#else
    : IC
#endif
{
#if DEBUG
    void Log() { Console.WriteLine("debug"); }
#else
    void Log() { }
#endif
    int F() { return 1; }
}
`;
    const result = await skeletonize(src, 'csharp');
    expect(result.hasErrors).toBe(false);
    expect(result.code).toContain(`#if DEBUG\n    void Log() ${P}\n#else\n    void Log() ${P}\n#endif`);
    expect(result.code).toContain(`#elif NET6_0\n    : IB\n#else\n    : IC`);
    expect(result.code).toContain(`int F() ${P}`);
    expect(result.strippedBodies).toBe(3);
  });

  it('keeps line offsets when blanking inactive branches', async () => {
    const { blankPreprocessor } = await import('../src/languages/csharp.js');
    const src = '#if A\r\nint a;\r\n#elif B\r\nint b;\r\n#else\r\nint c;\r\n#endif\r\nint d;\r\n';
    const out = blankPreprocessor(src);
    expect(out!.length).toBe(src.length);
    expect(out!.split('\r\n').map((l) => l.trim())).toEqual(['', 'int a;', '', '', '', '', '', 'int d;', '']);
  });
});

describe('Swift conditional compilation', () => {
  it('parses #if blocks inside type declarations', async () => {
    const src = `struct Instant {
    let value: Double

    #if canImport(Darwin) || canImport(Glibc)
    init() {
        value = now()
    }
    #else
    init() {
        value = Date().timeIntervalSince1970
    }
    #endif
}
`;
    const result = await skeletonize(src, 'swift');
    expect(result.hasErrors).toBe(false);
    expect(result.code).toBe(`struct Instant {
    let value: Double

    #if canImport(Darwin) || canImport(Glibc)
    init() ${P}
    #else
    init() ${P}
    #endif
}
`);
    expect(result.strippedBodies).toBe(2);
  });
});

describe('modern syntax parses without errors', () => {
  it.each([
    ['typescript', 'class A { accessor x = 1; m() { using r = get(); return 1; } }\nconst c = { a: 1 } satisfies Cfg;\nfunction g<const T>(x: T) { return x; }\n'],
    ['python', 'type P = tuple[int, int]\ndef f[T](x: T) -> T:\n    match x:\n        case 1:\n            pass\n    return x\n'],
    ['java', 'record R(int a) { R { check(); } }\nsealed interface S permits A {}\nfinal class A implements S { void m(Object o) { if (o instanceof String s) {} } }\n'],
    ['csharp', 'public record Point(int X, int Y);\nclass A { required public int P { get; init; } void M() { var x = y is { Z: > 1 }; } }\n'],
    ['kotlin', 'value class V(val v: Int)\nclass A(val x: Int) {\n    init { check() }\n}\n'],
    ['scala', 'enum Color { case Red, Green }\nclass A(x: Int):\n  def g = 1\n'],
    ['bash', 'f() {\n  cat <<EOF\nhi\nEOF\n}\n[[ $x =~ ^a ]] && g\n'],
    ['php', '<?php\nenum Suit: string { case H = "h"; }\n$f = fn($x) => $x;\n'],
    ['swift', 'actor Store {\n    func load() async throws -> Int { if let x { return x }; return 0 }\n}\n@MainActor struct V: View {\n    var body: some View { Text("hi") }\n}\n'],
  ] as const)('%s', async (lang, src) => {
    await expectValid(src, lang as LanguageId);
  });
});
