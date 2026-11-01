import type { ModuleMigration, SqlDatabase } from '@aether/plugin-api';
import type { PMNode } from './doc.js';
import { docStats, emptyDoc } from './doc.js';

export interface WriterDoc {
  id: string;
  title: string;
  template: string;
  kind: string;
  style: 'apa' | 'ieee' | 'mla' | 'chicago';
  font: string;
  content: PMNode;
  words: number;
  createdAt: number;
  updatedAt: number;
}

export type WriterDocSummary = Omit<WriterDoc, 'content'>;

export const WRITER_MIGRATIONS: ModuleMigration[] = [
  {
    version: 1,
    up: `CREATE TABLE aether_writer_docs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, title TEXT NOT NULL, template TEXT NOT NULL, kind TEXT NOT NULL, style TEXT NOT NULL, font TEXT NOT NULL, content TEXT NOT NULL, words INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX aether_writer_docs_profile ON aether_writer_docs(profile_id, updated_at);
CREATE TABLE aether_writer_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, words INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX aether_writer_versions_doc ON aether_writer_versions(doc_id, created_at);`,
  },
];

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

interface Row {
  id: string;
  title: string;
  template: string;
  kind: string;
  style: string;
  font: string;
  content?: string;
  words: number;
  created_at: number;
  updated_at: number;
}

const toDoc = (r: Row): WriterDoc => ({
  id: r.id,
  title: r.title,
  template: r.template,
  kind: r.kind,
  style: r.style as WriterDoc['style'],
  font: r.font,
  content: r.content ? (JSON.parse(r.content) as PMNode) : emptyDoc(),
  words: r.words,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Documents per profile. Private windows get an in-memory database. */
export class WriterStore {
  constructor(private db: SqlDatabase, private now: () => number = Date.now) {}

  list(profileId: string): WriterDocSummary[] {
    return (this.db.prepare('SELECT id,title,template,kind,style,font,words,created_at,updated_at FROM aether_writer_docs WHERE profile_id=? ORDER BY updated_at DESC').all(profileId) as Row[]).map((r) => {
      const { content: _c, ...rest } = toDoc(r);
      return rest;
    });
  }

  get(profileId: string, id: string): WriterDoc | null {
    const r = this.db.prepare('SELECT * FROM aether_writer_docs WHERE profile_id=? AND id=?').get(profileId, id) as Row | undefined;
    return r ? toDoc(r) : null;
  }

  create(profileId: string, init: Partial<Omit<WriterDoc, 'id' | 'createdAt' | 'updatedAt' | 'words'>>): WriterDoc {
    const t = this.now();
    const doc: WriterDoc = {
      id: rid(),
      title: init.title || 'Untitled document',
      template: init.template || 'blank',
      kind: init.kind || 'document',
      style: init.style || 'apa',
      font: init.font || 'Calibri',
      content: init.content ?? emptyDoc(),
      words: 0,
      createdAt: t,
      updatedAt: t,
    };
    doc.words = docStats(doc.content).words;
    this.db
      .prepare('INSERT INTO aether_writer_docs (id,profile_id,title,template,kind,style,font,content,words,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(doc.id, profileId, doc.title, doc.template, doc.kind, doc.style, doc.font, JSON.stringify(doc.content), doc.words, t, t);
    return doc;
  }

  update(profileId: string, id: string, patch: Partial<Pick<WriterDoc, 'title' | 'style' | 'font' | 'content' | 'kind'>>): WriterDoc | null {
    const cur = this.get(profileId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: this.now() };
    next.words = docStats(next.content).words;
    this.db
      .prepare('UPDATE aether_writer_docs SET title=?,style=?,font=?,kind=?,content=?,words=?,updated_at=? WHERE profile_id=? AND id=?')
      .run(next.title, next.style, next.font, next.kind, JSON.stringify(next.content), next.words, next.updatedAt, profileId, id);
    return next;
  }

  delete(profileId: string, id: string): boolean {
    const r = this.db.prepare('DELETE FROM aether_writer_docs WHERE profile_id=? AND id=?').run(profileId, id);
    this.db.prepare('DELETE FROM aether_writer_versions WHERE doc_id=?').run(id);
    return Number(r.changes) > 0;
  }

  snapshot(profileId: string, id: string, label: string): number | null {
    const d = this.get(profileId, id);
    if (!d) return null;
    const r = this.db.prepare('INSERT INTO aether_writer_versions (doc_id,label,content,words,created_at) VALUES (?,?,?,?,?)').run(id, label.slice(0, 120), JSON.stringify(d.content), d.words, this.now());
    // Keep the newest 50 versions per document.
    this.db.prepare('DELETE FROM aether_writer_versions WHERE doc_id=? AND id NOT IN (SELECT id FROM aether_writer_versions WHERE doc_id=? ORDER BY id DESC LIMIT 50)').run(id, id);
    return Number(r.lastInsertRowid);
  }

  versions(profileId: string, id: string): { id: number; label: string; words: number; createdAt: number }[] {
    if (!this.get(profileId, id)) return [];
    return (this.db.prepare('SELECT id,label,words,created_at FROM aether_writer_versions WHERE doc_id=? ORDER BY id DESC').all(id) as { id: number; label: string; words: number; created_at: number }[]).map((v) => ({ id: v.id, label: v.label, words: v.words, createdAt: v.created_at }));
  }

  restore(profileId: string, id: string, versionId: number): WriterDoc | null {
    const v = this.db.prepare('SELECT content FROM aether_writer_versions WHERE doc_id=? AND id=?').get(id, versionId) as { content: string } | undefined;
    if (!v) return null;
    this.snapshot(profileId, id, 'Before restore');
    return this.update(profileId, id, { content: JSON.parse(v.content) as PMNode });
  }

  deleteProfile(profileId: string): void {
    this.db.prepare('DELETE FROM aether_writer_versions WHERE doc_id IN (SELECT id FROM aether_writer_docs WHERE profile_id=?)').run(profileId);
    this.db.prepare('DELETE FROM aether_writer_docs WHERE profile_id=?').run(profileId);
  }
}
