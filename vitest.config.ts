import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Same WebAssembly setting as the CLI (see src/cli.ts): avoids large TurboFan compile
    // memory spikes when many workers load every grammar at once.
    execArgv: ['--liftoff-only'],
    // The first test in a file loads grammars and tokenizers cold; on busy CI runners
    // (Windows especially) that alone can exceed vitest's 5 s default.
    testTimeout: 20_000,
  },
});
