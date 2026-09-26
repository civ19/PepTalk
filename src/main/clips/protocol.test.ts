import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sessionFileUrl } from '../../shared/flags-bridge';
import { createClipHandler, parseRange } from './protocol';

const ID = '405d0588-302d-4b44-9e4e-96c8a73c75fe';
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

let root: string;
let handler: (request: Request) => Promise<Response>;
let junctionOk = false;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'clip-protocol-'));
  root = join(base, 'sessions');
  mkdirSync(join(root, ID, 'clips'), { recursive: true });
  writeFileSync(join(root, ID, 'clips', 'abc.mp4'), BYTES);
  writeFileSync(join(root, ID, 'clips', 'abc.jpg'), BYTES.slice(0, 10));
  writeFileSync(join(root, ID, 'session.json'), '{"secret":true}');
  writeFileSync(join(root, ID, 'empty.mp4'), new Uint8Array(0));
  mkdirSync(join(root, ID, 'folder.mp4'));
  // Outside the sessions folder.
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'secret.mp4'), BYTES);
  writeFileSync(join(base, 'secret.mp4'), BYTES);
  try {
    // A junction needs no special rights on Windows (a symlink elsewhere).
    symlinkSync(join(base, 'outside'), join(root, ID, 'escape'), 'junction');
    junctionOk = true;
  } catch {
    junctionOk = false;
  }
  handler = createClipHandler(root);
});

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => handler(new Request(url, { method, headers }));
const body = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const clipUrl = (rel: string) => sessionFileUrl(ID, rel);

describe('parseRange', () => {
  it.each([
    [null, null],
    ['bytes=0-', { start: 0, end: 999 }],
    ['bytes=100-199', { start: 100, end: 199 }],
    ['bytes=990-5000', { start: 990, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
    ['bytes=1000-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=500-100', null],
    ['bytes=0-1,5-9', null],
    ['items=0-1', null],
    ['bytes=-', null],
  ] as const)('%s', (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });
});

describe('clip:// handler', () => {
  it('serves the whole file with range support advertised', async () => {
    const r = await get(clipUrl('clips/abc.mp4'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('content-length')).toBe('1000');
    expect(await body(r)).toEqual(BYTES);
  });

  it('answers any Range with 206 and exactly those bytes', async () => {
    const all = await get(clipUrl('clips/abc.mp4'), { Range: 'bytes=0-' });
    expect(all.status).toBe(206);
    expect(all.headers.get('content-range')).toBe('bytes 0-999/1000');
    expect((await body(all)).length).toBe(1000);

    const mid = await get(clipUrl('clips/abc.mp4'), { Range: 'bytes=100-199' });
    expect(mid.status).toBe(206);
    expect(mid.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(mid.headers.get('content-length')).toBe('100');
    expect(await body(mid)).toEqual(BYTES.slice(100, 200));

    const tail = await get(clipUrl('clips/abc.mp4'), { Range: 'bytes=-10' });
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await body(tail)).toEqual(BYTES.slice(990));
  });

  it('streams large ranges in several chunks', async () => {
    const big = Uint8Array.from({ length: 700_000 }, (_, i) => (i * 7) % 256);
    writeFileSync(join(root, ID, 'clips', 'big.mp4'), big);
    const r = await get(clipUrl('clips/big.mp4'), { Range: 'bytes=1-600000' });
    expect(r.status).toBe(206);
    expect(Buffer.from(await body(r)).equals(Buffer.from(big.subarray(1, 600_001)))).toBe(true);
  });

  it('returns 416 past the end', async () => {
    const r = await get(clipUrl('clips/abc.mp4'), { Range: 'bytes=1000-' });
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */1000');
  });

  it('answers HEAD without a body, and rejects other methods', async () => {
    const head = await get(clipUrl('clips/abc.mp4'), { Range: 'bytes=0-9' }, 'HEAD');
    expect(head.status).toBe(206);
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.body).toBeNull();
    expect((await get(clipUrl('clips/abc.mp4'), {}, 'POST')).status).toBe(405);
  });

  it('serves thumbnails as JPEG and empty files as empty', async () => {
    const jpg = await get(clipUrl('clips/abc.jpg'));
    expect(jpg.headers.get('content-type')).toBe('image/jpeg');
    expect((await body(jpg)).length).toBe(10);
    const empty = await get(clipUrl('empty.mp4'));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-length')).toBe('0');
  });

  it('404s missing files and folders', async () => {
    expect((await get(clipUrl('clips/nope.mp4'))).status).toBe(404);
    expect((await get(clipUrl('folder.mp4'))).status).toBe(404);
    expect((await get(sessionFileUrl('00000000-0000-4000-8000-000000000000', 'clips/abc.mp4'))).status).toBe(404);
  });

  it.each([
    ['non-media file', `clip://local/${ID}/session.json`],
    ['no session id', 'clip://local/clips/abc.mp4'],
    ['wrong host', `clip://elsewhere/${ID}/clips/abc.mp4`],
    ['dot-dot (normalized away by the URL parser)', `clip://local/${ID}/../../secret.mp4`],
    ['encoded dot-dot', `clip://local/${ID}/%2e%2e/%2e%2e/secret.mp4`],
    ['encoded slashes', `clip://local/${ID}/..%2F..%2Fsecret.mp4`],
    ['encoded backslashes', `clip://local/${ID}/..%5C..%5Csecret.mp4`],
    ['drive letter', `clip://local/${ID}/C:%5Cwindows%5Cwin.mp4`],
    ['NTFS stream', `clip://local/${ID}/clips/abc.mp4:hidden.mp4`],
    ['NUL byte', `clip://local/${ID}/clips/abc%00.mp4`],
    ['bad escape', `clip://local/${ID}/clips/%E0%A4%A.mp4`],
    ['port', `clip://local:8080/${ID}/clips/abc.mp4`],
  ])('403s %s', async (_name, url) => {
    expect((await get(url)).status).toBe(403);
  });

  it('ignores query strings (e.g. cache busting)', async () => {
    expect((await get(`${clipUrl('clips/abc.mp4')}?v=2`)).status).toBe(200);
  });

  it('403s a junction/symlink that leads out of the sessions folder', async (ctx) => {
    if (!junctionOk) ctx.skip();
    expect((await get(clipUrl('escape/secret.mp4'))).status).toBe(403);
  });
});
