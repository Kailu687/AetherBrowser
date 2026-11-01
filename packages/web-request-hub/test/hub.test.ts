import { describe, expect, it, vi } from 'vitest';
import { WebRequestHub, type ElectronRequestDetails, type SessionLike } from '../src/index.js';

function fakeSession() {
  const listeners: Record<string, ((d: ElectronRequestDetails, cb: (r: any) => void) => void) | null> = {};
  const session: SessionLike = {
    webRequest: {
      onBeforeRequest: (l) => void (listeners.before = l as any),
      onBeforeSendHeaders: (l) => void (listeners.send = l as any),
      onHeadersReceived: (l) => void (listeners.received = l as any),
    },
  };
  const call = (name: string, details: Partial<ElectronRequestDetails>) =>
    new Promise<any>((resolve) =>
      listeners[name]!(
        { id: 1, url: 'https://a.com/x.js', method: 'GET', resourceType: 'script', referrer: '', timestamp: 0, ...details },
        resolve,
      ),
    );
  return { session, listeners, call };
}

describe('WebRequestHub', () => {
  it('runs handlers in order and stops at the first decision', async () => {
    const hub = new WebRequestHub();
    const { session, call } = fakeSession();
    hub.attach(session, 'p1');
    const second = vi.fn();
    hub.use({ name: 'a', onBeforeRequest: () => ({ redirectURL: 'aether://x' }) });
    hub.use({ name: 'b', onBeforeRequest: second });
    expect(await call('before', {})).toEqual({ redirectURL: 'aether://x' });
    expect(second).not.toHaveBeenCalled();
  });

  it('fails open when a handler throws and reports the error', async () => {
    const onError = vi.fn();
    const hub = new WebRequestHub({ onError });
    const { session, call } = fakeSession();
    hub.attach(session, 'p1');
    hub.use({ name: 'broken', onBeforeRequest: () => { throw new Error('boom'); } });
    hub.use({ name: 'ok', onBeforeRequest: async () => ({ cancel: true }) });
    expect(await call('before', {})).toEqual({ cancel: true });
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('chains header modifications and passes the session key', async () => {
    const hub = new WebRequestHub();
    const { session, call } = fakeSession();
    hub.attach(session, 'work');
    const keys: string[] = [];
    hub.use({ name: 'a', onBeforeSendHeaders: (ctx, h) => { keys.push(ctx.sessionKey); h['X-A'] = '1'; } });
    hub.use({ name: 'b', onBeforeSendHeaders: (_ctx, h) => ({ ...h, 'X-B': '2' }) });
    const r = await call('send', { requestHeaders: { Accept: '*/*' } });
    expect(r.requestHeaders).toEqual({ Accept: '*/*', 'X-A': '1', 'X-B': '2' });
    expect(keys).toEqual(['work']);
  });

  it('resolves the top-level URL for sub-resources and main frames', async () => {
    const hub = new WebRequestHub();
    const { session, call } = fakeSession();
    hub.attach(session, 'p');
    const seen: string[] = [];
    hub.use({ name: 'spy', onBeforeRequest: (ctx) => void seen.push(ctx.topLevelUrl) });
    await call('before', { resourceType: 'mainFrame', url: 'https://new.com/' });
    await call('before', { frame: { url: 'https://frame.com/', top: { url: 'https://top.com/' } } });
    await call('before', { webContents: { getURL: () => 'https://wc.com/' } });
    await call('before', { resourceType: 'unknownType', referrer: 'https://ref.com/' });
    expect(seen).toEqual(['https://new.com/', 'https://top.com/', 'https://wc.com/', 'https://ref.com/']);
  });

  it('removes listeners on detach and refuses double attach', () => {
    const hub = new WebRequestHub();
    const { session, listeners } = fakeSession();
    hub.attach(session, 'p');
    expect(() => hub.attach(session, 'p')).toThrow();
    hub.detach(session);
    expect(listeners.before).toBeNull();
  });
});
