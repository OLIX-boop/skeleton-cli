import { afterEach, describe, expect, it } from 'vitest';
import { dependencyGraph, mostImported, renderGraph } from '../src/deps.js';
import { render } from '../src/output/index.js';
import { pack } from '../src/pack.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function graphOf(files: Record<string, string>) {
  const t = await makeTree(files);
  cleanups.push(t.cleanup);
  const result = await pack(t.root);
  return { graph: Object.fromEntries(dependencyGraph(result)), result, map: dependencyGraph(result) };
}

describe('dependencyGraph', () => {
  it('resolves JS/TS relative imports, index files, NodeNext .js specifiers, require and dynamic import', async () => {
    const { graph } = await graphOf({
      'src/index.ts': "import { a } from './a.js';\nimport * as u from './util';\nexport * from './types';\nimport React from 'react';\n",
      'src/a.ts': "const b = require('./lib/b');\nconst lazy = () => import('./lazy');\nimport './side-effect';\n",
      'src/util/index.ts': 'export const u = 1;\n',
      'src/types.d.ts': 'export type T = 1;\n',
      'src/lib/b.js': 'module.exports = 1;\n',
      'src/lazy.tsx': 'export default 1;\n',
      'src/side-effect.ts': '',
      'src/App.vue': "<script setup lang=\"ts\">\nimport { a } from './a';\n</script>\n",
    });
    expect(graph).toEqual({
      'src/App.vue': ['src/a.ts'],
      'src/a.ts': ['src/lazy.tsx', 'src/lib/b.js', 'src/side-effect.ts'],
      'src/index.ts': ['src/a.ts', 'src/types.d.ts', 'src/util/index.ts'],
    });
  });

  it('resolves Python relative and absolute imports, including src layouts', async () => {
    const { graph } = await graphOf({
      'src/app/__init__.py': '',
      'src/app/main.py': 'from . import models\nfrom .db import session\nfrom app.utils.text import slug\nimport os\nimport app.config\n',
      'src/app/models.py': 'from ..shared import x\n',
      'src/app/db.py': '',
      'src/app/config.py': '',
      'src/app/utils/text.py': '',
      'src/shared.py': '',
    });
    expect(graph).toEqual({
      'src/app/main.py': ['src/app/config.py', 'src/app/db.py', 'src/app/models.py', 'src/app/utils/text.py'],
      'src/app/models.py': ['src/shared.py'],
    });
  });

  it('resolves `from . import name` to sibling modules, falling back to the package', async () => {
    const { graph } = await graphOf({
      'pkg/__init__.py': 'VERSION = 1\n',
      'pkg/a.py': 'from . import b, c as cc\nfrom . import VERSION\n',
      'pkg/b.py': '',
      'pkg/c.py': '',
      'top.py': 'from pkg import (\n    a,\n    b,\n)\nimport pkg.c, os\n',
    });
    expect(graph).toEqual({
      'pkg/a.py': ['pkg/__init__.py', 'pkg/b.py', 'pkg/c.py'],
      'top.py': ['pkg/a.py', 'pkg/b.py', 'pkg/c.py'],
    });
  });

  it('only links Go imports inside a module declared in the pack', async () => {
    const { graph } = await graphOf({
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\n\nimport (\n\t"log"\n\t"errors"\n\t"github.com/other/lib/pkg/util"\n\t"example.com/app/pkg/util"\n)\n',
      'log/log.go': 'package log\n',
      'errors/errors.go': 'package errors\n',
      'pkg/util/util.go': 'package util\n',
    });
    expect(graph).toEqual({ 'main.go': ['pkg/util/util.go'] });
  });

  it('resolves Go package imports to a file of the package', async () => {
    const { graph } = await graphOf({
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/store"\n)\n',
      'internal/store/store.go': 'package store\n\nimport "example.com/app/internal/model"\n',
      'internal/store/store_test.go': 'package store\n',
      'internal/model/model.go': 'package model\n',
    });
    expect(graph).toEqual({
      'main.go': ['internal/store/store.go'],
      'internal/store/store.go': ['internal/model/model.go'],
    });
  });

  it('resolves Rust mod declarations, Java imports, C includes, Ruby and PHP requires', async () => {
    const { graph } = await graphOf({
      'src/main.rs': 'mod config;\npub mod net;\nfn main() {}\n',
      'src/config.rs': '',
      'src/net/mod.rs': 'mod tcp;\n',
      'src/net/tcp.rs': '',
      'java/src/main/java/com/acme/App.java': 'package com.acme;\nimport com.acme.util.Strings;\nimport java.util.List;\n',
      'java/src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\n',
      'c/main.c': '#include "util.h"\n#include <stdio.h>\n',
      'c/util.h': '',
      'rb/app.rb': "require_relative 'lib/helper'\nrequire 'json'\n",
      'rb/lib/helper.rb': '',
      'php/index.php': "<?php\nrequire_once __DIR__ . '/src/boot.php';\n",
      'php/src/boot.php': '<?php\n',
      'lua/init.lua': "local util = require('app.util')\nlocal cfg = require \"app.config\"\n",
      'lua/app/util.lua': '',
      'lua/app/config/init.lua': '',
    });
    expect(graph).toMatchObject({
      'src/main.rs': ['src/config.rs', 'src/net/mod.rs'],
      'src/net/mod.rs': ['src/net/tcp.rs'],
      'java/src/main/java/com/acme/App.java': ['java/src/main/java/com/acme/util/Strings.java'],
      'c/main.c': ['c/util.h'],
      'rb/app.rb': ['rb/lib/helper.rb'],
      'php/index.php': ['php/src/boot.php'],
      'lua/init.lua': ['lua/app/config/init.lua', 'lua/app/util.lua'],
    });
  });

  it('resolves Zig, Solidity, Julia, Haskell and Objective-C imports', async () => {
    const { graph } = await graphOf({
      'zig/main.zig': 'const std = @import("std");\nconst util = @import("util.zig");\n',
      'zig/util.zig': '',
      'sol/Token.sol': 'import "./IERC20.sol";\nimport {Math} from "./lib/Math.sol";\n',
      'sol/IERC20.sol': '',
      'sol/lib/Math.sol': '',
      'jl/Main.jl': 'include("geometry.jl")\n',
      'jl/geometry.jl': '',
      'hs/app/Main.hs': 'import qualified Data.Stack as S\nimport Data.List (sort)\n',
      'hs/src/Data/Stack.hs': 'module Data.Stack where\n',
      'objc/App.m': '#import "Stack.h"\n#import <Foundation/Foundation.h>\n',
      'objc/Stack.h': '',
    });
    expect(graph).toMatchObject({
      'zig/main.zig': ['zig/util.zig'],
      'sol/Token.sol': ['sol/IERC20.sol', 'sol/lib/Math.sol'],
      'jl/Main.jl': ['jl/geometry.jl'],
      'hs/app/Main.hs': ['hs/src/Data/Stack.hs'],
      'objc/App.m': ['objc/Stack.h'],
    });
  });

  it('ranks the most imported files and renders the graph', async () => {
    const { map, result } = await graphOf({
      'a.ts': "import './shared';\n",
      'b.ts': "import './shared';\nimport './a';\n",
      'shared.ts': '',
    });
    expect(mostImported(map)).toEqual([
      { path: 'shared.ts', importers: 2 },
      { path: 'a.ts', importers: 1 },
    ]);
    expect(renderGraph(map, result.files)).toBe('a.ts -> shared.ts\nb.ts -> a.ts, shared.ts');
    const md = render('markdown', result, { projectName: 'p', dependencies: map });
    expect(md).toContain('## Dependencies');
    expect(md).toContain('b.ts -> a.ts, shared.ts');
    expect(JSON.parse(render('json', result, { projectName: 'p', dependencies: map })).dependencies).toEqual({
      'a.ts': ['shared.ts'],
      'b.ts': ['a.ts', 'shared.ts'],
    });
  });
});
