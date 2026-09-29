import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Same WebAssembly setting as the CLI (see src/cli.ts): avoids large TurboFan compile
    // memory spikes when many workers load every grammar at once.
    execArgv: ['--liftoff-only'],
  },
});
