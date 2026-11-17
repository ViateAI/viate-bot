import { lookup } from 'node:dns/promises';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP, createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE = 200 * 1024 * 1024;
const MAX_METADATA = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export type ArchiveInput = { bytes: Buffer; format: 'tar' | 'tgz'; sourceUrl: string };
export type ArchiveCallback<T> = (archive: ArchiveInput) => Promise<T> | T;
export type Address = { address: string; family: number };
export type IngestOptions = { resolve?: (hostname: string) => Promise<Address[]> };

/** Reject special-purpose and non-globally-routable addresses, including mapped IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    const a = p[0] ?? 0;
    const b = p[1] ?? 0;
    const c = p[2] ?? 0;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map((v) => parseInt(v, 16));
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  // Only global unicast; exclude protocol-assignment, documentation and 6to4 ranges.
  return (first & 0xe000) === 0x2000 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

function httpsUrl(value: string, registryOnly = false): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (registryOnly && (url.hostname !== 'registry.npmjs.org' || (url.port && url.port !== '443')))) {
    throw new Error('Ingest URL must be an allowed HTTPS URL without credentials or fragment');
  }
  return url;
}

/** Resolve all records before connecting; a mixed public/private answer is unsafe. */
export async function resolvePublicAddresses(hostname: string, resolve: NonNullable<IngestOptions['resolve']> = defaultResolve): Promise<Address[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!records.length || records.some((record) => !isPublicAddress(record.address) || isIP(record.address) !== record.family)) {
    throw new Error('Ingest host resolves to a non-public address');
  }
  return records;
}

async function defaultResolve(hostname: string): Promise<Address[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function download(value: string, limit: number, options: IngestOptions, registryOnly: boolean): Promise<Buffer> {
  let url = httpsUrl(value, registryOnly);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const addresses = await resolvePublicAddresses(url.hostname, options.resolve);
    const { promise, resolve, reject } = Promise.withResolvers<{ redirect?: string; body?: Buffer }>();
    const req = request(url, {
        // Pin the validated address: the TLS connection must not perform a second DNS lookup.
        lookup: (_host, _opts, callback) => {
          const pinned = addresses[0];
          if (!pinned) { callback(new Error("地址无效"), "", 4); return; }
          callback(null, pinned.address, pinned.family);
        },
        family: addresses[0]?.family ?? 4,
        agent: false,
        headers: { accept: 'application/json, application/octet-stream' },
        timeout: 30_000,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: new URL(res.headers.location, url).href });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Ingest download failed with HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) res.destroy(new Error('Ingest download exceeds size limit'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ body: Buffer.concat(chunks, size) }));
    });
    req.on('timeout', () => req.destroy(new Error('Ingest download timed out')));
    req.on('error', reject);
    req.end();
    const result = await promise;
    if (result.body) return result.body;
    if (!result.redirect || redirects === MAX_REDIRECTS) throw new Error('Too many ingest redirects');
    url = httpsUrl(result.redirect, registryOnly);
  }
  throw new Error('Too many ingest redirects');
}

/** Download npm metadata and its registry-hosted tarball; never run package scripts. */
export async function ingestNpm<T>(name: string, version: string, archive: ArchiveCallback<T>, options: IngestOptions = {}): Promise<T> {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !version || version.length > 128) {
    throw new Error('Invalid npm package name or version');
  }
  const metadata = JSON.parse((await download(`https://registry.npmjs.org/${encodeURIComponent(name)}`, MAX_METADATA, options, true)).toString('utf8'));
  const selected = metadata['dist-tags']?.[version] ?? version;
  const tarball = metadata.versions?.[selected]?.dist?.tarball;
  if (typeof tarball !== 'string') throw new Error('npm version has no tarball');
  httpsUrl(tarball, true);
  const bytes = await download(tarball, MAX_ARCHIVE, options, true);
  return archive({ bytes, format: 'tgz', sourceUrl: tarball });
}

/** Clone on control through a validating CONNECT proxy, then pass a git archive to the importer. */
export async function ingestGit<T>(value: string, archive: ArchiveCallback<T>, options: IngestOptions = {}): Promise<T> {
  const url = httpsUrl(value);
  const directory = await mkdtemp(join(tmpdir(), 'viate-app-git-'));
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let header = '';
    socket.on('data', function onHeader(chunk) {
      header += chunk.toString('latin1');
      if (header.length > 8192) { socket.destroy(); return; }
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onHeader);
      const match = /^CONNECT (\[[0-9a-fA-F:]+\]|[^\s:]+):(\d+) HTTP\/1\.[01]\r\n/.exec(header);
      const host = match?.[1];
      const portText = match?.[2];
      const port = portText === undefined ? Number.NaN : Number(portText);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { socket.destroy(); return; }
      void resolvePublicAddresses(host, options.resolve).then((addresses) => {
        if (socket.destroyed) return;
        const pinned = addresses[0];
        if (!pinned) { socket.destroy(); return; }
        const upstream = connect({ host: pinned.address, port, family: pinned.family });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const remainder = Buffer.from(header.slice(end + 4), 'latin1');
          if (remainder.length) upstream.write(remainder);
          socket.pipe(upstream).pipe(socket);
        });
      }).catch(() => socket.destroy());
    });
  });
  try {
    const listening = Promise.withResolvers<void>();
    proxy.once('error', listening.reject);
    proxy.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Could not start ingest proxy');
    const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', NO_PROXY: '', no_proxy: '' };
    const config = ['-c', `http.proxy=http://127.0.0.1:${address.port}`, '-c', 'http.followRedirects=true', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper='];
    await execFileAsync('git', [...config, 'clone', '--bare', '--', url.href, join(directory, 'repo')], { env, timeout: 600_000, maxBuffer: 1024 * 1024 });
    const archived = Promise.withResolvers<Buffer>();
    const child = spawn('git', ['-C', join(directory, 'repo'), 'archive', '--format=tar', 'HEAD'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ARCHIVE) { tooLarge = true; child.kill(); } else chunks.push(chunk);
    });
    child.on('error', archived.reject);
    child.on('close', (code) => {
      if (tooLarge) archived.reject(new Error('Git archive exceeds size limit'));
      else if (code !== 0) archived.reject(new Error('Git archive failed'));
      else archived.resolve(Buffer.concat(chunks, size));
    });
    const bytes = await archived.promise;
    return await archive({ bytes, format: 'tar', sourceUrl: url.href });
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}
