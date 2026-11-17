import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ responses: [] as Array<{ status: number; location?: string; body?: string }>, urls: [] as string[] }));
vi.mock('node:https', () => ({
  request: (url: URL, _options: unknown, receive: (response: EventEmitter & { statusCode: number; headers: object; resume: () => void }) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    req.destroy = (error) => { req.emit('error', error); };
    req.end = () => queueMicrotask(() => {
      transport.urls.push(url.href);
      const entry = transport.responses.shift();
      if (!entry) { req.emit('error', new Error('Unexpected request')); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; resume: () => void; destroy: (error: Error) => void };
      res.statusCode = entry.status;
      res.headers = entry.location ? { location: entry.location } : {};
      res.resume = () => {};
      res.destroy = (error) => { res.emit('error', error); };
      receive(res);
      if (entry.body) res.emit('data', Buffer.from(entry.body));
      res.emit('end');
    });
    return req;
  },
}));

import { ingestGit, ingestNpm, isPublicAddress, resolvePublicAddresses } from './ingest.js';

describe('catalog ingest', () => {
  beforeEach(() => { transport.responses = []; transport.urls = []; });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '2001:db8::1'])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('checks every DNS answer rather than only the first', async () => {
    await expect(resolvePublicAddresses('example.com', async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('non-public');
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('imports the selected npm tarball through the archive callback', async () => {
    transport.responses.push(
      { status: 200, body: JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' } } } }) },
      { status: 200, body: 'archive bytes' },
    );
    const result = await ingestNpm('pkg', 'latest', (input) => ({ ...input, bytes: input.bytes.toString() }), { resolve: async () => [{ address: '8.8.8.8', family: 4 }] });
    expect(result).toEqual({ bytes: 'archive bytes', format: 'tgz', sourceUrl: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' });
  });

  it('rejects npm tarballs and redirects outside the registry', async () => {
    transport.responses.push({ status: 302, location: 'https://example.com/metadata' });
    await expect(ingestNpm('pkg', 'latest', () => null, { resolve: async () => [{ address: '8.8.8.8', family: 4 }] })).rejects.toThrow('HTTPS');
    expect(transport.urls).toHaveLength(1);
  });

  it('rejects an npm metadata tarball hosted elsewhere', async () => {
    transport.responses.push({ status: 200, body: JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://example.com/pkg.tgz' } } } }) });
    await expect(ingestNpm('pkg', '1.0.0', () => null, { resolve: async () => [{ address: '8.8.8.8', family: 4 }] })).rejects.toThrow('HTTPS');
    expect(transport.urls).toHaveLength(1);
  });

  it('revalidates DNS before following a registry redirect', async () => {
    transport.responses.push({ status: 302, location: '/elsewhere' });
    let calls = 0;
    await expect(ingestNpm('pkg', 'latest', () => null, { resolve: async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }] })).rejects.toThrow('non-public');
    expect(transport.urls).toHaveLength(1);
  });

  it('rejects non-HTTPS and credentialed git URLs before cloning', async () => {
    await expect(ingestGit('http://example.com/repo', () => null)).rejects.toThrow('HTTPS');
    await expect(ingestGit('https://user:secret@example.com/repo', () => null)).rejects.toThrow('HTTPS');
  });
});
