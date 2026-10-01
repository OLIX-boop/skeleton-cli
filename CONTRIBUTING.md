# Contributing to astpack

Thanks for helping! This guide covers the local setup, the project layout and the most common contribution:
adding or improving a language.

## Setup

```sh
npm install
npm test            # vitest (runs from src/, no build needed)
npm run lint
npm run typecheck
npm run build       # tsc (grammars/ is committed; `npm run grammars` refreshes it)
node dist/cli.js .  # try the CLI on this repository
```

Node.js 22.12 or newer is required.

## Layout

| Path | What lives there |
| --- | --- |
| `src/engine/` | Tree-sitter loading (`parser.ts`), the skeleton walker (`skeleton.ts`), comment handling, per-file transform with fallbacks (`transform.ts`), grammar binary patching |
| `src/languages/` | One `LanguageSpec` per language, plus embedded formats (Vue/Svelte/Astro) |
| `src/walker/` | File discovery and ignore rules, focus matching |
| `src/output/` | Markdown / XML / JSON renderers and the directory tree |
| `src/tokens/` | Token counting, pricing and statistics |
| `src/budget.ts`, `src/split.ts` | `--max-tokens` and `--split-tokens` |
| `src/deps.ts` | `--deps` import graph |
| `src/git.ts` | `--changed`, `--diff`, `--remote` |
| `src/security/` | Secret redaction |
| `src/mcp/` | The MCP server |
| `src/cli/` | Command-line parsing, commands and the terminal summary |

## Adding a language

1. Find an npm package that ships the grammar's `.wasm` (most official `tree-sitter-<lang>` packages do), add
   it to `GRAMMARS` in `scripts/vendor-grammars.mjs` and run `npm run grammars`. For a package that ships only
   C sources, use `{ build: '<package>@<version>' }`: it is compiled with the tree-sitter CLI, which needs
   Emscripten (`emcc` on `PATH`) or Docker; `patches` can fix upstream bugs in the sources before the build. Parse a sample and look at
   `tree.rootNode.toString()` to learn the node types.
2. Create `src/languages/<name>.ts` exporting a `LanguageSpec`:
   - `candidates`: the node types that own implementation bodies (functions, methods, closures…).
   - `bodyReplacement(node, placeholder)`: return `{ node: body, text }` for the span to replace, or `null`.
     The replacement must keep the file syntactically valid (an empty block with a comment, `...`, etc.).
     Helpers in `common.ts` cover the usual cases (`braceBlock`, `innerBraces`, `isMultiline`).
3. Register it in `src/languages/index.ts` and add its id to `LanguageId` in `types.ts`.
4. Add a case to `test/languages.test.ts` with realistic code and the exact expected output. The shared
   `expectValid` helper checks that the output re-parses without errors and that a second pass changes nothing.
5. Optionally teach `src/deps.ts` how to resolve the language's imports.
6. Document it in the README's language table.

If the grammar imports libc symbols the runtime lacks, add them to `IMPORT_RENAMES` in
`src/engine/wasm-patch.ts` (see the Bash grammar for an example).

## Pull requests

- Keep changes focused and include tests; `npm test`, `npm run lint` and `npm run typecheck` must pass.
- Update `CHANGELOG.md` under *Unreleased* for user-visible changes.
- If you change the config options, run `npm run schema` to regenerate `schema.json`.

## Releasing

Bump the version in `package.json`, move the *Unreleased* changelog entries under the new version, commit,
then push a matching tag (`git tag v0.2.1 && git push origin v0.2.1`). The release workflow tests, builds,
publishes to npm with provenance and creates the GitHub release.

npm access, in order of preference:

1. **Trusted publishing** (no secret): on npmjs.com, *astpack → Settings → Trusted Publisher → GitHub
   Actions*, with owner `OLIX-boop`, repository `skeleton-cli` and workflow `release.yml`. Leave the
   `NPM_TOKEN` secret unset (or delete it): when it exists, the workflow uses it instead.
2. **A token**: a *granular access token* with read and write access and **Bypass two-factor
   authentication** checked (the account needs 2FA enabled for that option to appear), stored as the
   `NPM_TOKEN` repository secret.

If a release fails after the tag was pushed (e.g. npm refused it), fix the access and re-run it from
*Actions → Release → Run workflow* with the tag. A version that is already on npm (say, published by hand
with `npm publish`) is skipped, and an existing GitHub release is left alone, so re-runs are safe.
