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
    init { /* ... */ }

    constructor(url: String) : this(Repo(url)) { /* ... */ }

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
