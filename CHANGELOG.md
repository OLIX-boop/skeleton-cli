# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First release.

### Added

- Skeleton mode: Tree-sitter body stripping for TypeScript, JavaScript (incl. JSX/TSX), Python, Go, Rust, Java,
  C#, C, C++, Ruby, PHP, Kotlin, Swift, Scala, Dart, Elixir and Bash, plus `<script>` blocks in Vue, Svelte
  and Astro files. Output re-parses cleanly and is idempotent.
- Focus mode (`--focus`) and raw mode (`--full`); unsupported files are included up to a line/character limit.
- File discovery honouring nested `.gitignore`, the enclosing repository's rules, `.git/info/exclude`,
  `.packignore`/`.astpackignore`, `--ignore` and `--include`, with built-in excludes for dependencies,
  lockfiles, binaries, build output and likely secrets.
- Markdown, XML and JSON output; `--stdout`, `--clipboard`, `--instructions`, `--no-tree`.
- Token analytics for `cl100k_base` and `o200k_base`, savings versus raw source, and per-model input cost.
- `--outline` repo-map mode (also a budget step), `--comments all|docs|none`, `--max-tokens` budgets, `--split-tokens` part files, `--deps` import graph.
- Git integration: `--changed`, `--diff`, `--remote`.
- Secret redaction (on by default, `--no-redact`).
- `astpack.config.json` / `.astpackrc` with a JSON Schema, `astpack init`.
- `astpack mcp`, a Model Context Protocol server with `pack_codebase`, `estimate_tokens` and `skeleton_file`.
- `--dry-run`, `--stats-json` and `--watch`; transforms and token counts are cached in memory, so repeated
  MCP calls and watch rebuilds only redo changed files.
- A GitHub Action (`action.yml`) with token outputs and a job summary.
- Programmatic API (`pack`, `render`, `skeletonize`, `fitToBudget`, `computeStats`, …).

[Unreleased]: https://github.com/OLIX-boop/skeleton-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OLIX-boop/skeleton-cli/releases/tag/v0.1.0
