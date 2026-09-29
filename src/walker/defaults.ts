/** Directories never worth packaging (VCS metadata, dependencies, caches, build output). */
export const DEFAULT_IGNORED_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.pnpm-store',
  '.yarn',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ipynb_checkpoints',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode-test',
  'coverage',
  '.nyc_output',
  'dist',
  'build',
  '.terraform',
] as const;

/** Lockfiles: large, machine-generated and useless to an LLM. */
export const DEFAULT_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'flake.lock',
  'Podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'packages.lock.json',
] as const;

/** Binary, media, archive and bulk-data extensions. */
export const DEFAULT_BINARY_EXTENSIONS = [
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tif', 'tiff', 'psd', 'heic', 'svgz',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // audio / video
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'jar', 'war', 'whl', 'egg',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  // compiled / native
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'pyd', 'wasm', 'node', 'bin',
  // data
  'db', 'sqlite', 'sqlite3', 'parquet', 'avro', 'feather', 'arrow', 'pkl', 'pickle', 'npy', 'npz', 'h5', 'hdf5',
  'onnx', 'pt', 'pth', 'ckpt', 'safetensors', 'tfrecord',
] as const;

/** Generated or noisy text files. */
export const DEFAULT_GENERATED_PATTERNS = [
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.tsbuildinfo',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  // VCS metadata with no meaning for a model
  '.git-blame-ignore-revs',
  '.mailmap',
  '.gitattributes',
  'astpack-output.*',
  // astpack's own configuration
  'astpack.config.json',
  '.astpackrc',
  '.astpackrc.json',
  '.packignore',
  '.astpackignore',
] as const;

/**
 * Files that commonly hold secrets. Packaged output is pasted into third-party LLMs, so
 * these are excluded unless the user opts out of default ignores. Templates stay included.
 */
export const DEFAULT_SECRET_PATTERNS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!.env.dist',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '*.tfstate',
  '*.tfstate.*',
] as const;

/** All default excludes as gitignore-style patterns. */
export function defaultIgnorePatterns(): string[] {
  return [
    ...DEFAULT_IGNORED_DIRS.map((d) => `${d}/`),
    ...DEFAULT_LOCKFILES,
    ...DEFAULT_BINARY_EXTENSIONS.map((e) => `*.${e}`),
    ...DEFAULT_GENERATED_PATTERNS,
    ...DEFAULT_SECRET_PATTERNS,
  ];
}

/** Default maximum size of a single file (bytes). Larger files are skipped. */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
