#!/usr/bin/env node
/** Write index.html from src/. Thin wrapper so tests can build in-process. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArtifact } from './build-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'index.html');
const page = buildArtifact(root);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
process.stdout.write(`built ${out} (${(Buffer.byteLength(page) / 1024).toFixed(1)} KiB)\n`);
