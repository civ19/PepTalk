// The clip:// protocol (see CLIP_SCHEME in src/shared/flags-bridge.ts): serves
// media files from the sessions folder to the renderer, with HTTP range
// requests so <video> can seek and scrub. No Electron import, so it can be
// tested with plain Request objects; src/main/flags/ipc.ts registers it.
//
//   clip://local/<sessionId>/clips/<clipId>.mp4  ->  <sessionsDir>/<sessionId>/clips/<clipId>.mp4
//
// Only media files (.mp4 .webm .jpg .jpeg .png) inside a session folder are
// served. Anything else, including paths that would leave the sessions folder
// through '..', encoded separators or symlinks, gets 403.

import { open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { CLIP_HOST, CLIP_SCHEME } from '../../shared/flags-bridge';

/** For protocol.registerSchemesAsPrivileged, which must run before the app is ready. */
export const CLIP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true } as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK_BYTES = 256 * 1024;

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parses a Range header for a file of `size` bytes. null means "send the whole
 * file": no header, or one that is ignored as RFC 9110 allows (malformed,
 * backwards, or several ranges). 'unsatisfiable' means 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const first = m[1] ?? '';
  const last = m[2] ?? '';
  if (first === '' && last === '') return null;
  if (first === '') {
    // Suffix range: the last N bytes.
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

/** True if `child` is strictly inside `parent` (both absolute). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/** Maps a clip:// URL to a file under `root` and its content type, or null if the URL isn't allowed. */
function resolveTarget(root: string, url: URL): { file: string; contentType: string } | null {
  if (url.protocol !== `${CLIP_SCHEME}:` || url.hostname !== CLIP_HOST || url.username || url.port) return null;
  let segments: string[];
  try {
    segments = url.pathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const [sessionId, ...rest] = segments;
  const name = rest[rest.length - 1];
  if (!sessionId || !UUID_RE.test(sessionId) || name === undefined) return null;
  // Every decoded segment must be a plain name: no separators, dot segments, drive letters or NTFS streams (':'), or NULs.
  if (rest.some((s) => s === '.' || s === '..' || /[\\/:\0]/.test(s))) return null;
  const contentType = CONTENT_TYPES[extname(name).toLowerCase()];
  if (!contentType) return null;
  const file = resolve(root, sessionId, ...rest);
  return isInside(root, file) ? { file, contentType } : null;
}

const plain = (status: number, text: string, extra: Record<string, string> = {}): Response =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });

/** Streams bytes [start, end] of an open file, closing it when done or cancelled. */
function fileStream(handle: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const want = Math.min(CHUNK_BYTES, end + 1 - pos);
        const buf = new Uint8Array(Math.max(0, want));
        const { bytesRead } = want > 0 ? await handle.read(buf, 0, want, pos) : { bytesRead: 0 };
        if (bytesRead === 0) {
          // Done (or the file got shorter than it was when the response started).
          await close();
          controller.close();
          return;
        }
        pos += bytesRead;
        controller.enqueue(bytesRead === want ? buf : buf.subarray(0, bytesRead));
      } catch (err) {
        await close();
        controller.error(err);
      }
    },
    cancel: close,
  });
}

/** Handler for protocol.handle(CLIP_SCHEME, ...). */
export function createClipHandler(sessionsDir: string): (request: Request) => Promise<Response> {
  const root = resolve(sessionsDir);
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed', { Allow: 'GET, HEAD' });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, 'bad url');
    }
    const target = resolveTarget(root, url);
    if (!target) return plain(403, 'forbidden');

    // Resolve symlinks and junctions: the real file must still be inside the sessions folder.
    let realFile: string;
    let realRoot: string;
    try {
      [realFile, realRoot] = await Promise.all([realpath(target.file), realpath(root)]);
    } catch {
      return plain(404, 'not found');
    }
    if (!isInside(realRoot, realFile)) return plain(403, 'forbidden');

    let handle: FileHandle;
    try {
      handle = await open(realFile, 'r');
    } catch {
      return plain(404, 'not found');
    }
    let size: number;
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      await handle.close().catch(() => undefined);
      return plain(404, 'not found');
    }

    const headers = new Headers({ 'Content-Type': target.contentType, 'Accept-Ranges': 'bytes' });
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      await handle.close().catch(() => undefined);
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers.set('Content-Length', String(length));
    // Any Range header gets a 206, even bytes=0-: that's how Chromium's media stack learns the file is seekable.
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || length === 0) {
      await handle.close().catch(() => undefined);
      return new Response(null, { status, headers });
    }
    return new Response(fileStream(handle, start, end), { status, headers });
  };
}
