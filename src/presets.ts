import type { AstpackConfig } from './config.js';

export interface Preset {
  description: string;
  /** Option defaults the preset applies (explicit flags and config values win). */
  options: AstpackConfig;
}

/** Ready-made combinations of options and instructions for common LLM tasks. */
export const PRESETS: Record<string, Preset> = {
  review: {
    description: 'code review of your changes: focus + diff vs the base branch, skeleton elsewhere',
    options: {
      changed: '@base',
      diff: true,
      comments: 'docs',
      instructions: [
        'You are reviewing the changes shown in the git diff. Files marked [focus] are the changed files in full;',
        'everything else is context in skeleton form. Report, in order of severity: bugs and incorrect behaviour,',
        'security problems, missing error handling or tests, and API/design concerns. For each finding give the file,',
        'the line or symbol, why it is a problem, and a concrete fix. Skip style nits unless they hide a bug.',
      ].join(' '),
    },
  },
  explain: {
    description: 'onboarding: outline of the whole repo plus the import graph',
    options: {
      mode: 'outline',
      deps: true,
      instructions: [
        'Explain the architecture of this codebase to a new contributor: the main components and their',
        'responsibilities, how data and control flow between them (use the dependency graph), the key types and',
        'entry points, and where to start reading for common tasks.',
      ].join(' '),
    },
  },
  refactor: {
    description: 'plan a refactor: focused files in full, the rest as skeletons with the import graph',
    options: {
      deps: true,
      comments: 'docs',
      instructions: [
        'Propose a refactoring plan for the files marked [focus]. Use the rest of the codebase (skeletons and the',
        'dependency graph) to find every caller and dependent that would be affected. Give the plan as ordered,',
        'independently shippable steps, each with the files it touches and how to verify it.',
      ].join(' '),
    },
  },
  debug: {
    description: 'track down a bug: focused files in full, the rest as skeletons',
    options: {
      comments: 'all',
      instructions: [
        'Help me find the root cause of a bug. The files marked [focus] are where I believe the problem is; the',
        'rest of the codebase is shown as skeletons for context. Describe the bug below, then reason about likely',
        'causes, which code paths are involved, and how to confirm and fix it.\n\nBug description: <describe the bug here>',
      ].join(' '),
    },
  },
};

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}
