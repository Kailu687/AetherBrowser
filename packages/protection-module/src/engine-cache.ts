import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineCache } from '@aether/privacy';

/** Stores compiled filter engines as files in the module's data directory. Writes are atomic. */
export function fileEngineCache(dir: string): EngineCache {
  const file = (key: string) => join(dir, `filters-${key.replace(/[^a-z0-9+_-]/gi, '_')}.bin`);
  return {
    async read(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch {
        return undefined;
      }
    },
    async write(key, data) {
      await mkdir(dir, { recursive: true });
      const target = file(key);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, target);
    },
  };
}
