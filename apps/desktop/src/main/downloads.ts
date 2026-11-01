import { existsSync } from 'node:fs';
import { join, parse as parsePath } from 'node:path';
import { app, shell, type DownloadItem, type Session } from 'electron';
import type { SessionContext } from '@aether/plugin-api';
import type { AetherStore } from '@aether/storage';
import type { DownloadItemState } from '../shared/types';

/** Picks "name (1).ext" style paths so downloads never overwrite files. */
export function uniquePath(dir: string, filename: string, exists: (p: string) => boolean = existsSync): string {
  const safe = sanitizeFilename(filename);
  const { name, ext } = parsePath(safe);
  let candidate = join(dir, safe);
  for (let i = 1; exists(candidate) && i < 10_000; i++) candidate = join(dir, `${name} (${i})${ext}`);
  return candidate;
}

export function sanitizeFilename(filename: string): string {
  // Windows-reserved characters and names, control chars, trailing dots/spaces.
  let s = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s.slice(0, 200) || 'download';
}

interface Live {
  item: DownloadItem;
  ctx: SessionContext;
  state: DownloadItemState;
  lastWrite: number;
}

/**
 * Tracks downloads per profile. Private-window downloads are kept in memory
 * only (the file itself is still saved where the user asked).
 */
export class DownloadManager {
  private live = new Map<number, Live>();
  private privateItems = new Map<string, DownloadItemState[]>();
  private nextPrivateId = -1;
  /** Called once per download that finishes successfully. */
  onCompleted: ((ctx: SessionContext, path: string) => void) | null = null;

  constructor(
    private store: AetherStore,
    private notify: (profileId: string, isPrivate: boolean, partition: string) => void,
  ) {}

  attach(ses: Session, ctx: SessionContext): void {
    ses.on('will-download', (_e, item) => this.track(item, ctx));
  }

  private track(item: DownloadItem, ctx: SessionContext): void {
    const profile = this.store.getProfile(ctx.profileId);
    const dir = profile?.downloadDir || app.getPath('downloads');
    if (profile?.askDownloadLocation) {
      item.setSaveDialogOptions({ defaultPath: uniquePath(dir, item.getFilename()) });
    } else {
      item.setSavePath(uniquePath(dir, item.getFilename()));
    }
    const base = {
      url: item.getURL(),
      filename: item.getFilename(),
      path: item.getSavePath(),
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
    };
    const id = ctx.isPrivate ? this.nextPrivateId-- : this.store.addDownload(ctx.profileId, base);
    const state: DownloadItemState = { id, url: base.url, filename: base.filename, path: base.path, totalBytes: base.totalBytes, receivedBytes: 0, state: 'progressing', paused: false, startedAt: Date.now() };
    const live: Live = { item, ctx, state, lastWrite: 0 };
    this.live.set(id, live);
    if (ctx.isPrivate) {
      const list = this.privateItems.get(ctx.partition) ?? [];
      list.unshift(state);
      this.privateItems.set(ctx.partition, list);
    }

    item.on('updated', (_e, s) => {
      state.receivedBytes = item.getReceivedBytes();
      state.totalBytes = item.getTotalBytes();
      state.path = item.getSavePath();
      state.paused = item.isPaused();
      state.state = s === 'interrupted' ? 'interrupted' : 'progressing';
      const now = Date.now();
      if (!ctx.isPrivate && now - live.lastWrite > 1000) {
        live.lastWrite = now;
        this.store.updateDownload(id, { receivedBytes: state.receivedBytes, totalBytes: state.totalBytes, path: state.path });
      }
      this.notify(ctx.profileId, ctx.isPrivate, ctx.partition);
    });
    item.once('done', (_e, s) => {
      state.receivedBytes = item.getReceivedBytes();
      state.path = item.getSavePath();
      state.state = s === 'completed' ? 'completed' : s === 'cancelled' ? 'cancelled' : 'interrupted';
      state.paused = false;
      if (!ctx.isPrivate) this.store.updateDownload(id, { receivedBytes: state.receivedBytes, state: state.state, path: state.path });
      this.live.delete(id);
      this.notify(ctx.profileId, ctx.isPrivate, ctx.partition);
      if (state.state === 'completed') this.onCompleted?.(ctx, state.path);
    });
    this.notify(ctx.profileId, ctx.isPrivate, ctx.partition);
  }

  list(ctx: { profileId: string; isPrivate: boolean; partition: string }): DownloadItemState[] {
    if (ctx.isPrivate) return this.privateItems.get(ctx.partition) ?? [];
    return this.store.listDownloads(ctx.profileId, 200).map((d) => {
      const live = this.live.get(d.id);
      if (live) return { ...live.state };
      return { id: d.id, url: d.url, filename: d.filename, path: d.path, totalBytes: d.totalBytes, receivedBytes: d.receivedBytes, state: d.state, paused: false, startedAt: d.startedAt };
    });
  }

  /** Performs a user action. Ownership is checked against the caller's profile. */
  action(id: number, action: 'open' | 'show' | 'cancel' | 'pause' | 'resume' | 'remove', ctx: { profileId: string; isPrivate: boolean; partition: string }): void {
    const live = this.live.get(id);
    const owned = live ? live.ctx.profileId === ctx.profileId && live.ctx.partition === ctx.partition : this.isOwned(id, ctx);
    if (!owned) throw new Error('Download not found');
    const path = live?.state.path ?? (id > 0 ? this.store.getDownload(id)?.path : this.privateItems.get(ctx.partition)?.find((d) => d.id === id)?.path) ?? '';
    switch (action) {
      case 'open':
        if (path) void shell.openPath(path);
        break;
      case 'show':
        if (path) shell.showItemInFolder(path);
        break;
      case 'cancel':
        live?.item.cancel();
        break;
      case 'pause':
        live?.item.pause();
        break;
      case 'resume':
        if (live?.item.canResume()) live.item.resume();
        break;
      case 'remove':
        if (live) live.item.cancel();
        if (id > 0) this.store.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
        else this.privateItems.set(ctx.partition, (this.privateItems.get(ctx.partition) ?? []).filter((d) => d.id !== id));
        break;
    }
    this.notify(ctx.profileId, ctx.isPrivate, ctx.partition);
  }

  private isOwned(id: number, ctx: { profileId: string; isPrivate: boolean; partition: string }): boolean {
    if (id < 0) return !!this.privateItems.get(ctx.partition)?.some((d) => d.id === id);
    return !ctx.isPrivate && this.store.getDownload(id)?.profileId === ctx.profileId;
  }

  activeCount(): number {
    return this.live.size;
  }
}
