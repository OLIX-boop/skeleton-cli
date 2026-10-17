// PreToolUse hook for Read: the first time in a session that Claude reads a large source file in full,
// suggest astpack's skeleton_file instead (it returns the file's API for a fraction of the tokens). Claude
// can read the file again to get it in full: the hint is shown once per file per session, never twice.
// No dependencies and no parsing, so it adds only Node's startup time to a Read.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

/** Files below this size are cheap to read whole. */
const MIN_BYTES = 6 * 1024;

/** Extensions astpack skeletonizes (keep in sync with src/languages). */
const CODE = new Set(
  ('.ts .tsx .mts .cts .js .jsx .mjs .cjs .py .pyi .go .rs .java .cs .c .h .cc .cpp .cxx .hpp .hh .hxx .rb .php ' +
    '.kt .kts .swift .scala .sc .dart .ex .exs .lua .zig .sol .hs .ml .mli .jl .m .mm .vue .svelte .astro .ipynb')
    .split(' '),
);

function allow() {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}
const file = input?.tool_input?.file_path;
// Partial reads (offset/limit) already target something specific.
if (typeof file !== 'string' || input.tool_input.offset !== undefined || input.tool_input.limit !== undefined) allow();
if (process.env.ASTPACK_READ_HINT === '0' || !CODE.has(extname(file).toLowerCase())) allow();

let size;
try {
  size = statSync(file).size;
} catch {
  allow();
}
if (size < MIN_BYTES) allow();

// Remember which files were already hinted in this session.
const session = String(input.session_id ?? 'default').replace(/[^\w-]/g, '_');
const dir = join(tmpdir(), 'astpack-read-hint');
const marker = join(dir, `${session}-${createHash('sha1').update(file).digest('hex').slice(0, 16)}`);
try {
  statSync(marker);
  allow();
} catch {
  // Not hinted yet.
}
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, '');
} catch {
  // Can't remember it: better to never hint than to hint on every read.
  allow();
}

const tokens = Math.round(size / 3.6 / 100) * 100;
const reason =
  `This file is about ${tokens.toLocaleString('en-US')} tokens. If you only need what it offers (its classes, ` +
  `methods, exports and signatures), astpack's skeleton_file tool returns that for a fraction of the tokens ` +
  `(function bodies replaced by placeholders). If you need the implementation or are going to edit it, just ` +
  `Read it again: this note is shown only once per file.`;
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
);
