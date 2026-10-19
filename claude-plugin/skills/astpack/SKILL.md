---
name: astpack
description: >-
  Read code as skeletons (imports, types, signatures, classes and docs; function bodies replaced by
  placeholders), usually 50-90% fewer tokens than reading the files. Use it instead of Read when you need to
  know what code offers rather than change it: before reading a source file just to see its classes,
  methods, exports or signatures ("what does X expose", "what methods does this service have"), use
  skeleton_file; when starting in a project for the first time in a session (cold start, another computer,
  fresh clone, "give me an overview", "how is this organised", "explain this codebase"), or before opening
  more than a few files, use pack_codebase (mode outline for large projects); to locate a feature, use
  pack_codebase with query; to catch up on pulled changes, use changed. For documents (PDF, Word, PowerPoint,
  Excel, OpenDocument, EPUB, RTF, e-mail), use read_document instead of Read: text instead of page images,
  an outline first for long ones, handwritten or scanned pages as cropped images, saved with
  save_transcription so they are text next time. Not for code files you are about to edit or small files.
---

# astpack: understand code without reading every line

astpack parses source files with Tree-sitter and keeps what carries the design (imports, exports, types,
interfaces, class members, function signatures, docstrings), replacing implementation bodies with
placeholders such as `{ /* ... */ }` or `...`. The result is valid code in the original language, so you
can reason about the structure exactly as if you had read the files.

The point is spending context on what you will actually use. Reading twenty files to learn how a project is
laid out can cost tens of thousands of tokens; the same picture as a skeleton or outline costs a fraction,
and leaves the context for the files you then work on.

## When to use it

Reach for astpack first in these situations. Skipping it here wastes the most tokens:

1. **Cold start.** You are in a project you haven't explored in this session: a new session, the user
   switched computers, a fresh clone, or they ask for an overview, an explanation of the architecture, or
   where to start. Get the map before opening files:
   - small or medium project: `pack_codebase` (default skeleton mode);
   - large project, or when unsure: `estimate_tokens` first, then `pack_codebase` with `mode: "outline"`
     (one line per declaration: the most compact map), optionally `include` to narrow to a sub-tree.
2. **Finding where something lives.** "Where is authentication handled?", "which files deal with
   invoices?": `pack_codebase` with `query: "<the feature in a few words>"`. The best-matching files come
   back in full, everything else as skeletons. Add `related: 1` to include their imports and importers.
3. **Learning an API.** You found a file (with Grep or Glob, say) and need what it offers (its classes,
   methods, exports, signatures, how to call it), not how it works inside: call `skeleton_file` instead of
   `Read`. It returns the same declarations for a fraction of the tokens, and takes `paths: [...]` for
   several files in one call. Read the full file only if you then need a specific body.
4. **Catching up on changes.** The user pulled work done elsewhere, or asks what changed:
   `pack_codebase` with `changed: "ORIG_HEAD"` (after a pull) or `changed: "HEAD"` (uncommitted work) and
   `focus` empty. Changed files come back in full, the rest as context. Use the `diff` from git if you
   need the exact lines.
5. **Big context on a budget.** When a broad view must fit a limit, pass `maxTokens` and astpack
   compresses file by file (full → skeleton → outline → omitted) until it fits.

6. **Reading documents.** For a PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF or e-mail file, call
   `read_document` instead of `Read`. Reading a PDF directly sends every page as an image plus its text; the
   converted Markdown costs a fraction. Small documents come back whole; long ones as an outline of headings
   with section sizes: then ask for the `section` (by heading text) or `pages` you need.
   Pages with handwriting (OneNote exports, tablet notes), scans or drawings have no text layer: they come back
   as compact images, cropped to the content. After reading them, call `save_transcription` with what each
   page says (text, lists, formulas, a short description of drawings): later reads, in any session or on
   another machine once `.astpack/` is committed, get that text instead of images.

## When not to use it

Read files the normal way when:

- you are about to **edit** the file, or need its exact implementation, line numbers or a specific bug's
  code: skeletons hide bodies by design;
- the file is **small** (under a hundred lines or so) or you need only one or two files you already know;
- the content is **not code** (Markdown, configuration, data): astpack includes it as-is, so it saves
  nothing;
- you already have the skeleton or outline of the project in this conversation: don't fetch it again.

A good pattern is skeleton first, then full reads of just the files you will change.

## Tools (MCP server `astpack`)

| Tool | Use |
| --- | --- |
| `pack_codebase` | The project as one document: tree plus every file, skeletonized. Key arguments: `mode` (`skeleton` / `outline` / `full`), `focus` (files kept verbatim), `query`, `related`, `changed`, `include` / `ignore`, `maxTokens`, `deps` (import graph). `path` defaults to the project root. |
| `estimate_tokens` | What `pack_codebase` would cost, the raw size and the largest files, without the document. Cheap; use it before packing an unfamiliar or large project. |
| `skeleton_file` | One file (`path`) or up to 20 (`paths`) with bodies stripped. |
| `read_document` | A document as Markdown: `mode` (`auto` / `full` / `skeleton` / `outline`), `section`, `pages`. Attaches images of pages that need looking at. |
| `save_transcription` | Store what looked-at pages say (`path`, `pages: [{ page, text }]`), reused by every later read. |

## Without the MCP server

If the tools aren't available, the same works through the CLI (Node.js 22.12+):

```sh
npx -y astpack --stdout -q --outline        # project map
npx -y astpack --stdout -q                  # skeleton of everything
npx -y astpack --stdout -q --query "invoice pdf export" --related
npx -y astpack --stdout -q --changed ORIG_HEAD --diff
npx -y astpack --dry-run                    # just the token counts
npx -y astpack doc report.pdf               # a document as Markdown (outline if long)
npx -y astpack doc report.pdf --section "Results" --pages 3-5
npx -y astpack doc notes.pdf --images /tmp/pages   # handwritten pages as cropped PNGs to view
```

## Reading the output

- `### path [focus]`, `[match]` or `[related]` files are complete, unmodified source.
- `[outline]` files list declarations only, members indented under their class or module.
- `{ /* ... */ }`, `...`, `= TODO()` and similar mark a stripped body: the code exists, it just isn't shown.
- `[truncated]`, `[minified]` and `[omitted]` mark files cut, recognised as machine-written, or left out to
  fit a budget. Read the file directly if you need it.
