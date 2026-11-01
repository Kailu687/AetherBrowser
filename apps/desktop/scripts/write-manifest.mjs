// Writes release/latest.json for the local-folder updater (src/main/updater.ts).
// Usage: node scripts/write-manifest.mjs "short release notes"
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const file = `AETHER-Setup-${version}.exe`;
const sha256 = createHash('sha256').update(readFileSync(join(root, 'release', file))).digest('hex');
const notes = process.argv[2] ?? '';
writeFileSync(join(root, 'release', 'latest.json'), JSON.stringify({ version, file, sha256, notes }, null, 2) + '\n');
console.log(`latest.json -> ${version} ${sha256}`);
