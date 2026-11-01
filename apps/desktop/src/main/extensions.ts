import { existsSync } from 'node:fs';
import type { Session } from 'electron';
import type { AetherStore } from '@aether/storage';

/**
 * Unpacked Chrome extensions, per profile (experimental). Electron supports a
 * subset of the extension APIs: content scripts, background service workers,
 * storage, runtime messaging and parts of chrome.tabs work; toolbar popups,
 * chrome.windows and many permission prompts do not. Never loaded into
 * private windows.
 */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  path: string;
}

const key = (profileId: string) => `extensions:${profileId}`;

export class ExtensionManager {
  constructor(private store: AetherStore) {}

  paths(profileId: string): string[] {
    return this.store.getSetting<string[]>(key(profileId), []);
  }

  /** Loads the profile's saved extensions into its session; missing folders are skipped. */
  async loadAll(ses: Session, profileId: string): Promise<void> {
    for (const path of this.paths(profileId)) {
      if (!existsSync(path)) continue;
      try {
        await ses.extensions.loadExtension(path, { allowFileAccess: false });
      } catch (err) {
        console.warn(`[extensions] could not load ${path}`, err);
      }
    }
  }

  list(ses: Session): ExtensionInfo[] {
    return ses.extensions.getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version, path: e.path }));
  }

  async add(ses: Session, profileId: string, path: string): Promise<ExtensionInfo> {
    if (!existsSync(`${path}/manifest.json`) && !existsSync(`${path}\\manifest.json`)) throw new Error('That folder has no manifest.json. Choose an unpacked extension folder.');
    const ext = await ses.extensions.loadExtension(path, { allowFileAccess: false });
    const list = this.paths(profileId).filter((p) => p !== path);
    this.store.setSetting(key(profileId), [...list, path]);
    return { id: ext.id, name: ext.name, version: ext.version, path: ext.path };
  }

  remove(ses: Session, profileId: string, id: string): void {
    const ext = ses.extensions.getExtension(id);
    if (!ext) return;
    ses.extensions.removeExtension(id);
    this.store.setSetting(key(profileId), this.paths(profileId).filter((p) => p !== ext.path));
  }
}
