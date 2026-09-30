#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [tsc, '--project', join(root, 'tsconfig.build.json')],
  {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  },
);
if (result.status !== 0) {
  process.stderr.write(
    result.stderr || result.stdout || 'runtime TypeScript build failed\n',
  );
  process.exit(result.status ?? 1);
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }, null, 2)}\n`,
);

for (const relativePath of ['extensions/background-tasks.js']) {
  const target = join(dist, relativePath);
  if (!existsSync(target)) {
    throw new Error(`runtime build did not emit ${relativePath}`);
  }
}

console.log(
  'runtime-build: compiled JavaScript entrypoints and deferred runtime closure into dist/.',
);
