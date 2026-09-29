# astpack

[![CI](https://github.com/OLIX-boop/skeleton-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/OLIX-boop/skeleton-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/astpack.svg)](https://www.npmjs.com/package/astpack)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Pack a whole codebase into one LLM-ready prompt — at a fraction of the tokens.**

Repository packers like Repomix or Gitingest dump every line of source into a single file. That overflows
context windows and spends most of the budget on function bodies the model doesn't need to understand the
architecture. `astpack` parses every file with [Tree-sitter](https://tree-sitter.github.io/) and keeps what
carries the mental model — imports, exports, types, interfaces, structs, class members, signatures and
docs — while replacing implementation bodies with a placeholder. The files you are actually working on stay
100% intact.

```sh
npx astpack                      # pack the current directory → astpack-output.md
npx astpack --focus src/auth -c  # src/auth in full, everything else as a skeleton, copied to the clipboard
```

On real projects that is **49–89% fewer tokens** than packing raw source ([benchmarks](#benchmarks)).

---

## Contents

- [Before / after](#before--after)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Modes: skeleton, focus, full](#modes-skeleton-focus-full)
  - [Working with git](#working-with-git)
  - [Token budgets and splitting](#token-budgets-and-splitting)
  - [Comments](#comments)
  - [Filtering](#filtering)
  - [Output formats](#output-formats)
  - [Dependency graph](#dependency-graph)
  - [Secret redaction](#secret-redaction)
- [CLI reference](#cli-reference)
- [Configuration file](#configuration-file)
- [MCP server](#mcp-server)
- [GitHub Action](#github-action)
- [Supported languages](#supported-languages)
- [Benchmarks](#benchmarks)
- [Programmatic API](#programmatic-api)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Development](#development)

## Before / after

<table>
<tr><th>Source (<code>src/auth/session.ts</code>)</th><th>What the LLM receives</th></tr>
<tr>
<td>

```ts
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** A logged-in user's session. */
export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export class SessionStore {
  private readonly ttlSeconds = 60 * 60 * 24;

  constructor(private readonly redis: Redis) {}

  /** Create a session and persist it with a TTL. */
  async create(userId: string): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
    };
    await this.redis.set(`session:${session.id}`,
      JSON.stringify(session), 'EX', this.ttlSeconds);
    return session;
  }

  /** Look up a session, returning null when missing or expired. */
  async get(id: string): Promise<Session | null> {
    const raw = await this.redis.get(`session:${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    parsed.expiresAt = new Date(parsed.expiresAt);
    return parsed.expiresAt > new Date() ? parsed : null;
  }

  async revoke(id: string): Promise<void> {
    await this.redis.del(`session:${id}`);
  }
}
```

</td>
<td>

```ts
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** A logged-in user's session. */
export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export class SessionStore {
  private readonly ttlSeconds = 60 * 60 * 24;

  constructor(private readonly redis: Redis) { /* ... */ }

  /** Create a session and persist it with a TTL. */
  async create(userId: string): Promise<Session> { /* ... */ }

  /** Look up a session, returning null when missing or expired. */
  async get(id: string): Promise<Session | null> { /* ... */ }

  async revoke(id: string): Promise<void> { /* ... */ }
}
```

</td>
</tr>
</table>

Every run ends with a summary of what was packed and what it costs:

```text
astpack summary
┌──────────────────────┬─────────────────────────────────────────┐
│ Mode                 │ skeleton                                │
│ Files scanned        │ 67                                      │
│ Files included       │ 64  (36 skeleton, 26 full, 2 truncated) │
│ Skipped              │ 3  (3 ignored)                          │
│ Bodies stripped      │ 595                                     │
│ Output size          │ 194 KB  (198,122 chars)                 │
│ Tokens (cl100k_base) │ 48,248  of 168,186 raw                  │
│ Tokens (o200k_base)  │ 47,552  of 165,760 raw                  │
│ Tokens saved         │ 71%                                     │
└──────────────────────┴─────────────────────────────────────────┘

┌────────────────────┬──────────────┬───────┬──────────┐
│ Model              │ Input tokens │  Cost │ Raw cost │
├────────────────────┼──────────────┼───────┼──────────┤
│ Claude 3.5 Sonnet* │       48,248 │ $0.14 │    $0.50 │
│ Claude Sonnet 5.5* │       48,248 │ $0.10 │    $0.34 │
│ GPT-4o             │       47,552 │ $0.12 │    $0.41 │
└────────────────────┴──────────────┴───────┴──────────┘
* Claude token counts are estimated with cl100k_base; Claude uses its own tokenizer.

┌─────────────────────────────┬────────┬───────┐
│ Top 5 files                 │ Tokens │ Saved │
├─────────────────────────────┼────────┼───────┤
│ command.go                  │  7,599 │   52% │
│ command_test.go             │  2,994 │   87% │
│ completions.go              │  2,262 │   77% │
│ site/content/active_help.md │  2,039 │     - │
│ LICENSE.txt                 │  2,017 │     - │
└─────────────────────────────┴────────┴───────┘

✔ Wrote astpack-output.md
```

<sub>(`npx astpack --remote spf13/cobra`)</sub>

## Features

- **Skeleton mode** — AST-accurate body stripping for **17 languages** plus Vue, Svelte and Astro single-file
  components. The output stays syntactically valid and re-processing it is a no-op.
- **Focus mode** — keep chosen files, directories or globs verbatim while the rest of the project is a skeleton.
- **Git-aware** — `--changed main` focuses everything your branch touched; `--diff` embeds the diff itself;
  `--remote owner/repo` packs any repository through a shallow clone.
- **Token budgets** — `--max-tokens 100k` compresses progressively (skeleton → doc comments only → no
  comments → omit files, tests and docs first) until the document fits. `--split-tokens 32k` writes it as parts.
- **Accurate analytics** — exact `cl100k_base` and `o200k_base` token counts (tiktoken's encodings, via the
  pure-JS [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer); parity with `tiktoken` is tested),
  raw-vs-packed savings, per-model input cost and the largest files.
- **Safe by default** — honours `.gitignore` (nested, and the repo's own when you pack a sub-directory),
  skips dependencies, lockfiles, binaries, `.env` files and private keys, and masks secrets that slipped into
  code.
- **Dependency graph** — `--deps` adds a `file -> imports` map of the project's internal modules.
- **Three formats** — Markdown (default), LLM-style XML and JSON; `--clipboard` and `--stdout` for piping.
- **MCP server** — `astpack mcp` exposes `pack_codebase`, `estimate_tokens` and `skeleton_file` to Claude and other agents.
- **Zero config, zero compilation** — WASM grammars, no native build step; an optional `astpack.config.json`
  when you want defaults per project.

## Installation

Run it without installing:

```sh
npx astpack
```

Or install it globally or per project:

```sh
npm install -g astpack      # then: astpack
npm install -D astpack      # then: npx astpack, or an npm script
```

Requires Node.js 22.12 or newer. Grammars ship pre-compiled (WASM, brotli-compressed), so nothing is built on install.

## Usage

```sh
astpack [directory] [options]
```

By default astpack packs the current directory in skeleton mode, writes `astpack-output.md`, and prints the summary.

```sh
astpack                                   # current directory → astpack-output.md
astpack ../api -o api.md                  # another directory, custom output file
astpack --stdout | pbcopy                 # pipe it anywhere (the summary goes to stderr)
astpack -c                                # also copy it to the clipboard
astpack -f xml --instructions "Find the race condition in the job queue."
astpack --instructions @prompts/review.md # read the instructions from a file
astpack --watch --focus src/checkout      # keep astpack-output.md up to date while you work
```

### Modes: skeleton, focus, full

| Mode | Command | What you get |
| --- | --- | --- |
| Skeleton (default) | `astpack` or `astpack --skeleton` | Every supported file with implementation bodies replaced by a placeholder; everything structural kept. |
| Focus | `astpack --focus <path>` | Focused files are included verbatim; all others as skeletons. Ideal for debugging one area with the rest of the app as context. |
| Full | `astpack --full` | Raw source for every file, like a classic packer (comment stripping and budgets still apply). |

`--focus` takes files, directories and globs, and can be repeated:

```sh
astpack --focus src/billing --focus src/api/invoices.ts
astpack --focus "**/*.test.ts"
astpack --focus "app/[id]/page.tsx"       # existing paths win over glob syntax
```

Files in languages astpack can't parse (Markdown, YAML, SQL, …) are included as-is up to 200 lines /
16,000 characters in skeleton mode (`--fallback-lines`, `--fallback-chars`), then truncated with a note.

### Working with git

```sh
astpack --changed                  # focus uncommitted + untracked changes
astpack --changed main --diff      # focus what this branch changed since main, and include the diff
astpack --remote vercel/swr        # pack a GitHub repo (owner/repo, URL, GitHub tree URL, or any git URL)
astpack --remote owner/repo#dev --focus src/core
```

`--changed <ref>` diffs against the merge-base of `<ref>` and `HEAD`, so commits that landed on `main` after
you branched don't count as "your" changes.

### Token budgets and splitting

```sh
astpack --max-tokens 100k          # compress until the whole document fits in 100,000 tokens
astpack --split-tokens 32k         # write astpack-output.part1.md, part2.md, … of ≤ 32,000 tokens each
```

`--max-tokens` never touches focused files. It degrades everything else one step at a time, largest
savings first, re-measuring the exact document after each step:

1. full source → skeleton,
2. all comments → documentation comments only,
3. → no comments,
4. omit files — tests and fixtures first, then docs, then other non-code files, then code.

Omitted files still appear in the directory tree marked `[omitted]`, so the model knows they exist.
`--split-tokens` cuts only between files and puts the tree, instructions and diff in part 1.

### Comments

```sh
astpack --comments docs    # keep documentation (JSDoc, docstrings, ///, attached comments), drop the rest
astpack --comments none    # drop all comments
```

Directives always survive: shebangs, `//go:build`, `// @ts-…`, `# -*- coding …`, `# noqa`, `# type:` and similar.
`docs` keeps doc syntax (`/** */`, `///`, `//!`, Python docstrings) and comment blocks attached to a
declaration outside function bodies, unless they look like commented-out code. Focused files are never changed.

### Filtering

astpack decides what to include in this order:

1. **Built-in excludes** (`--no-default-ignores` to disable): VCS and dependency directories (`.git`,
   `node_modules`, `.venv`, tool caches…), build output (`dist`, `build`, `.next`, `coverage`…),
   lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`…),
   binaries and media (images, fonts, archives, PDFs, compiled objects, model weights, databases), minified
   files and source maps, and likely secrets (`.env*` except templates, `*.pem`, `*.key`, SSH keys, `.npmrc`…).
2. **`.gitignore`** (`--no-gitignore` to disable) — nested files, `.git/info/exclude`, and the enclosing
   repository's rules when you pack a sub-directory.
3. **`.packignore` / `.astpackignore`** (`--no-packignore`) — gitignore syntax, for things you want in git
   but not in prompts.
4. **`--ignore <patterns>`** — extra gitignore-style patterns, comma-separated or repeated.
5. **`--include <patterns>`** — if given, only matching files are kept.

Files larger than 1 MB (`--max-file-size`) and files containing NUL bytes are skipped. Symlinks are skipped
unless you pass `--follow-symlinks` (cycle-safe).

### Output formats

| Format | Flag | Shape |
| --- | --- | --- |
| Markdown | `-f markdown` (default) | A header explaining the conventions, the directory tree, then each file in a fenced code block (fences grow if the file contains backticks). |
| XML | `-f xml` | `<project>`, `<notes>`, `<directory_structure>`, `<files><file path=… language=… strategy=…>` — the tag style Claude's long-context guidance recommends. Content is not escaped. |
| JSON | `-f json` | `{ project, mode, tree, files: [{ path, language, strategy, focused, content, … }], skipped, … }` for tooling. |

Output is deterministic (no timestamps), which keeps prompt caches warm across runs.

### Dependency graph

```sh
astpack --deps
```

adds a compact map of internal imports after the directory tree — one `file -> files it imports` line per
file — so the model sees how modules connect even when their bodies are stripped. Relative imports are resolved
for TypeScript/JavaScript (including NodeNext `.js` specifiers, `index` files, `require` and dynamic `import()`),
Python (relative and absolute, `src/` layouts), Go packages, Rust `mod` declarations, Java/Kotlin/Scala imports,
C/C++ `#include "…"`, Ruby `require_relative` and PHP `require`. Imports of external packages are left out.

### Secret redaction

Anything you pack is about to be pasted into a third-party model, so astpack masks likely credentials by default:
private key blocks, AWS/GitHub/GitLab/Anthropic/OpenAI/Slack/Stripe/Google/npm/PyPI/SendGrid/Twilio tokens,
JWTs, passwords in connection URLs, and high-entropy literals assigned to names like `password`, `secret` or
`api_key`. They become `[REDACTED:<rule>]`, and the summary tells you which files were affected. Placeholders
(`"changeme"`, `"${DB_PASSWORD}"`, `"<your-key>"`) are left alone. `--no-redact` turns this off.

This is a safety net, not a guarantee. Keep secrets out of your repository.

## CLI reference

| Option | Description |
| --- | --- |
| `[directory]` | Project root to pack (default `.`). |
| `-o, --output <file>` | Output file (default `astpack-output.<ext>`). Directories are created as needed. |
| `--stdout` | Write the document to stdout; the summary goes to stderr. |
| `-f, --format <format>` | `markdown` (default), `xml` or `json`. |
| `-s, --skeleton` | Strip function bodies from every supported file (default). |
| `--full` | Include raw source without AST transformation. |
| `--focus <path>` | Keep a file, directory or glob as full source (repeatable). |
| `-c, --clipboard` | Copy the document to the clipboard (pbcopy, PowerShell, wl-copy, xclip, xsel). |
| `-i, --ignore <patterns>` | Extra gitignore-style excludes (repeatable, comma-separated). |
| `--include <patterns>` | Only include matching files (repeatable, comma-separated). |
| `--no-gitignore` | Don't read `.gitignore` files. |
| `--no-packignore` | Don't read `.packignore` / `.astpackignore` files. |
| `--no-default-ignores` | Disable the built-in excludes. |
| `--max-file-size <size>` | Skip larger files, e.g. `500kb`, `2mb`; `0` for no limit (default 1 MB). |
| `--fallback-lines <n>` | Lines kept from unsupported files in skeleton mode (default 200). |
| `--fallback-chars <n>` | Characters kept from unsupported files in skeleton mode (default 16,000). |
| `--placeholder <text>` | Marker text for stripped bodies (default `...`). |
| `--comments <mode>` | `all` (default), `docs` or `none`, outside focused files. |
| `--max-tokens <n>` | Fit the document into a token budget, e.g. `100k`. |
| `--split-tokens <n>` | Split into part files of at most n tokens, e.g. `32k`. |
| `--no-tree` | Omit the directory tree. |
| `--deps` | Include the internal import graph (`file -> files it imports`). |
| `--instructions <text>` | Instructions at the top of the document; `@file` reads a file. |
| `--follow-symlinks` | Follow symbolic links. |
| `--no-redact` | Don't mask likely secrets. |
| `--changed [ref]` | Focus files changed vs a git ref (default `HEAD`: uncommitted and untracked). |
| `--diff [ref]` | Include the git diff vs a ref (default: the `--changed` ref, or `HEAD`). |
| `--remote <repo>` | Pack a remote repository (`owner/repo`, URL, optionally `#branch`). |
| `--config <file>` / `--no-config` | Use a specific config file / ignore config files. |
| `--models <ids>` | Models to price: `claude-3.5-sonnet`, `claude-sonnet-5.5`, `claude-opus-5.5`, `claude-haiku-4.5`, `claude-fable-5.1`, `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`. |
| `--top <n>` | Largest files listed in the summary (default 5; `0` hides the list). |
| `-q, --quiet` | Don't print the summary. |
| `--dry-run` | Compute everything and print the summary without writing the document or copying it (`--stats-json` is still written if requested). |
| `-w, --watch` | Keep running and re-pack whenever a file changes (unchanged files are served from an in-memory cache). |
| `--stats-json <file>` | Also write the summary statistics as JSON (tokens, costs, per-file sizes) — handy in CI. |
| `--no-color` | Disable colours (also respects `NO_COLOR` / `FORCE_COLOR`). |
| `-v, --version` | Print the version. |

| Command | Description |
| --- | --- |
| `astpack init [directory] [--force]` | Create `astpack.config.json` and a commented `.packignore`. |
| `astpack mcp [roots...]` | Run the MCP server over stdio (see [MCP server](#mcp-server)). |

Environment: `NO_COLOR` / `FORCE_COLOR` control colours; `ASTPACK_WASM_TIERUP=1` keeps V8's default
WebAssembly tiering (see [How it works](#how-it-works)).

Exit codes: `0` success, `1` error (message on stderr), other non-zero values for invalid arguments.

## Configuration file

`astpack.config.json` (or `.astpackrc.json` / `.astpackrc`) in the project root or the current directory sets
defaults using the long option names in camelCase. Command-line flags win; `ignore` and `include` lists are
merged; paths are relative to the config file.

```json
{
  "$schema": "https://unpkg.com/astpack/schema.json",
  "format": "xml",
  "focus": ["src/core"],
  "ignore": ["**/*.generated.ts", "fixtures/"],
  "comments": "docs",
  "maxTokens": "150k",
  "models": ["claude-sonnet-5.5", "gpt-4o"]
}
```

`astpack init` writes a starter file. The published [`schema.json`](schema.json) gives editors completion and
validation. Unknown keys produce a warning; invalid values are an error that names the key.

## MCP server

`astpack mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so agents can
pack code themselves:

| Tool | What it does |
| --- | --- |
| `pack_codebase` | The packed document for a directory: `focus`, `changed`, `mode`, `comments`, `include`, `ignore`, `format`, `maxTokens`, `deps`. |
| `estimate_tokens` | Packed vs raw token counts and the largest files, without the document, to pick focus and budgets. |
| `skeleton_file` | One file's skeleton: a cheap way to read its API. |

All tools are read-only and limited to the roots given on the command line (default: the directory the server
starts in).

**Claude Code**

```sh
claude mcp add astpack -- npx -y astpack mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and other MCP clients

```json
{
  "mcpServers": {
    "astpack": {
      "command": "npx",
      "args": ["-y", "astpack", "mcp", "/path/to/your/projects"]
    }
  }
}
```

## GitHub Action

Pack the repository in CI, upload the document as an artifact and get the token counts as outputs and in the
job summary:

```yaml
- uses: actions/checkout@v5
- uses: OLIX-boop/skeleton-cli@main
  id: astpack
  with:
    args: --comments docs --max-tokens 150k
- run: echo "Packed ${{ steps.astpack.outputs.tokens }} tokens (${{ steps.astpack.outputs.saved-percent }}% saved)"
```

Inputs: `path`, `args`, `format`, `output`, `version` (npm version, default `latest`), `upload`, `artifact-name`,
`summary`. Outputs: `output-path`, `files`, `tokens`, `raw-tokens`, `saved-percent`.

## Supported languages

| Language | Extensions | Bodies replaced | Kept |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts .mts .cts .tsx .js .mjs .cjs .jsx` | functions, methods, constructors, accessors, arrow functions and closures (multi-line expression bodies too), `static {}` blocks; `it`/`test` callbacks | imports, exports, types, interfaces, enums, namespaces, decorators, class fields, overloads, one-line arrows, `describe` structure |
| Python | `.py .pyi .pyw` | `def` / `async def` bodies → `...` | docstrings, classes, fields, decorators, lambdas, module code |
| Go | `.go` | functions, methods, function literals | packages, imports, types, structs, interfaces, consts, vars |
| Rust | `.rs` | `fn` bodies (free, `impl`, trait defaults), block closures | structs, enums, traits, `impl` headers, `use`, macros, attributes |
| Java | `.java` | methods, constructors, lambdas, static/instance initializers | fields, annotations, interfaces, enums, records |
| C# | `.cs` | methods, constructors, finalizers, operators, accessors, local functions, lambdas; multi-line `=>` members → `=> default` | properties, attributes, interfaces, records |
| C / C++ | `.c .h` / `.cpp .cc .cxx .hpp .hh …` | function definitions, inline methods, lambdas | structs, classes, templates, prototypes, macros, initializer lists |
| Ruby | `.rb .rake .gemspec .ru` | `def` bodies, RSpec `it`/`before` blocks → `# ...` | classes, modules, `attr_*`, DSL calls, endless methods, `describe`/`context` |
| PHP | `.php` | functions, methods, closures | namespaces, classes, traits, properties, attributes, arrow functions |
| Kotlin | `.kt .kts` | functions, accessors, `init`, secondary constructors; multi-line `=` bodies → `= TODO()` | classes, data classes, objects, properties, lambdas/DSLs |
| Swift | `.swift` | functions, initializers, `deinit`, subscripts, computed properties | types, protocols, extensions, stored properties |
| Scala | `.scala .sc` | block and multi-line `def` bodies | classes, traits, objects, case classes, one-line defs |
| Dart | `.dart` | function and method bodies | classes, mixins, fields, one-line arrows |
| Elixir | `.ex .exs` | `def`/`defp`/`defmacro` and ExUnit `test`/`setup` do-blocks | modules, attributes (`@doc`, `@spec`), `use`/`alias`, `describe` |
| Bash | `.sh .bash` | function bodies → `{ : '...'; }` | top-level commands and variables |
| Vue / Svelte / Astro | `.vue .svelte .astro` | functions inside `<script>` blocks and Astro frontmatter | templates, markup and styles |

Every other text file is included verbatim (truncated past the fallback limits in skeleton mode) with a
matching code-fence language.

## Benchmarks

Default settings, shallow clones, cl100k_base tokens for the complete Markdown document
(`node scripts/benchmark.mjs`):

| Repository | Language | Files | Raw (`--full`) | Skeleton | Skeleton + `--comments none` | Time |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [expressjs/express](https://github.com/expressjs/express) | JavaScript | 213 | 196,492 | 65,301 (−67%) | 55,614 (−72%) | 0.4s |
| [colinhacks/zod](https://github.com/colinhacks/zod) | TypeScript | 685 | 2,532,740 | 563,404 (−78%) | 500,923 (−80%) | 3.5s |
| [psf/requests](https://github.com/psf/requests) | Python | 115 | 720,722 | 94,390 (−87%) | 75,880 (−89%) | 0.4s |
| [spf13/cobra](https://github.com/spf13/cobra) | Go | 64 | 168,338 | 48,237 (−71%) | 34,133 (−80%) | 0.2s |
| [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | Rust | 227 | 919,228 | 406,790 (−56%) | 302,923 (−67%) | 1.2s |
| [google/gson](https://github.com/google/gson) | Java | 312 | 523,135 | 267,295 (−49%) | 157,362 (−70%) | 0.8s |

"Time" is packing only; token counting for the summary adds roughly a second per million characters.

## Programmatic API

```ts
import { pack, render, skeletonize, fitToBudget, computeStats } from 'astpack';

// One string
const { code } = await skeletonize(source, 'typescript');

// A whole project
const result = await pack('./my-app', { focus: ['src/billing'], comments: 'docs' });
const document = render('markdown', result, { projectName: 'my-app' });

// Fit a budget
const { document: fitted, tokens } = await fitToBudget(result, {
  maxTokens: 100_000,
  render: (r) => render('xml', r, { projectName: 'my-app' }),
});

// Analytics
const stats = computeStats(result, document, { models: ['claude-sonnet-5.5', 'gpt-4o'] });
console.log(stats.tokens.cl100k_base, stats.savedRatio);
```

The package also exports `walk`, `transformFile`, `splitPack`, `redactSecrets`, the language registry
(`LANGUAGES`, `languageForPath`) and the MCP server class (`AstpackMcpServer`).

## How it works

```text
walk ──► transform ──► render ──► (budget / split) ──► count ──► write / copy / print
```

1. **Walk** — directories are read concurrently in a stable order (files first, then sub-directories,
   alphabetical), applying the ignore layers above. Files over the size limit and binaries (NUL byte in the
   first 8 KiB) are skipped.
2. **Transform** — each file is parsed with [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web).
   A per-language rule set walks the tree with a cursor, finds implementation bodies and records edits: an
   empty block with a placeholder comment (`{ /* ... */ }`), `...` for Python, `= TODO()` for Kotlin, and so
   on, always something that parses again. Everything outside those spans is copied byte for byte, so
   formatting, comments and docs are exactly what you wrote. The same pass optionally removes comments and
   then masks secrets.
3. **Render** — Markdown, XML or JSON with a short legend telling the model what `...` means and which
   files are complete.
4. **Budget / split** — optional passes that re-transform files at other compression levels, or partition
   them into parts, measuring the real document each time.
5. **Count** — `cl100k_base` / `o200k_base` (tiktoken-identical, via `gpt-tokenizer`) on the final document,
   plus a raw baseline from each file's original content.

The CLI runs WebAssembly with V8's baseline compiler only (`--liftoff-only`, applied by re-launching itself
once). The grammars contain a few enormous functions; optimizing them costs more time than a CLI run gains
back and, on Node 24, over a gigabyte of memory. Set `ASTPACK_WASM_TIERUP=1` to keep V8's default tiering.

## Limitations

- **Grammar age.** The pre-built grammars date from the Tree-sitter 0.20 era. Very new syntax (for example
  TypeScript `accessor` fields, and some Swift/Kotlin constructs) is flagged as a parse error. The skeleton
  is still produced (text outside recognised bodies is kept verbatim) and the summary lists affected files.
- **Claude token counts are estimates.** Anthropic's tokenizer is not public; `cl100k_base` is used as a
  proxy. OpenAI counts are exact for the listed encodings.
- **Prices change.** The cost table uses list input prices per million tokens and is meant for comparison.
- **Lua** and a few other languages have grammars that don't work in this WASM build yet, so they fall
  back to raw inclusion.

## Development

```sh
npm install
npm test            # vitest
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # tsc + vendor brotli-compressed grammars into grammars/
npm run schema      # regenerate schema.json from src/config.ts
node scripts/benchmark.mjs owner/repo …
```

Adding a language means writing one `LanguageSpec` in `src/languages/` (which node types own bodies, and
what replaces them) and a test that checks the output re-parses cleanly.

## License

[MIT](LICENSE)
