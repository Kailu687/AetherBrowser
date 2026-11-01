import type { ModuleMigration } from '@aether/plugin-api';

/** Core shell schema. Module tables live under their own prefix and migration owner. */
export const CORE_MIGRATIONS: ModuleMigration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '',
        search_engine TEXT NOT NULL DEFAULT 'google',
        download_dir TEXT,
        ask_download_location INTEGER NOT NULL DEFAULT 0,
        close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'save', 'discard')),
        restore_on_startup INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE history_entries (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 0,
        typed_count INTEGER NOT NULL DEFAULT 0,
        last_visit_at INTEGER NOT NULL,
        UNIQUE (profile_id, url)
      );
      CREATE INDEX history_entries_recent ON history_entries(profile_id, last_visit_at DESC);

      CREATE TABLE history_visits (
        id INTEGER PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES history_entries(id) ON DELETE CASCADE,
        visited_at INTEGER NOT NULL,
        transition TEXT NOT NULL DEFAULT 'link'
      );
      CREATE INDEX history_visits_time ON history_visits(entry_id, visited_at DESC);

      CREATE TABLE bookmarks (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        url TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX bookmarks_parent ON bookmarks(profile_id, parent_id, position);
      CREATE INDEX bookmarks_url ON bookmarks(profile_id, url);

      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        filename TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT '',
        total_bytes INTEGER NOT NULL DEFAULT 0,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'progressing',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX downloads_recent ON downloads(profile_id, started_at DESC);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#7c8cff',
        icon TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        tabs_json TEXT NOT NULL DEFAULT '[]',
        active_index INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX workspaces_profile ON workspaces(profile_id, archived, updated_at DESC);

      -- One row per browser window worth restoring.
      --  state 'open'  : window is (or was, at crash/quit) open; restored on next launch.
      --  state 'saved' : user closed the window and chose to keep it.
      CREATE TABLE window_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'saved')),
        title TEXT NOT NULL DEFAULT '',
        bounds_json TEXT,
        maximized INTEGER NOT NULL DEFAULT 0,
        tabs_json TEXT NOT NULL DEFAULT '[]',
        active_index INTEGER NOT NULL DEFAULT 0,
        split_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX window_sessions_profile ON window_sessions(profile_id, state);

      CREATE TABLE site_permissions (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        permission TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, origin, permission)
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE module_kv (
        module_id TEXT NOT NULL,
        profile_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (module_id, profile_id, key)
      );
    `,
  },
  {
    version: 2,
    up: `
      -- Saved sign-ins. password_enc is encrypted by the OS (Electron safeStorage:
      -- DPAPI on Windows, Keychain on macOS, libsecret on Linux); the plaintext
      -- never touches the database.
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        domain TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE (profile_id, origin, username)
      );
      CREATE INDEX credentials_domain ON credentials(profile_id, domain);
    `,
  },
];
