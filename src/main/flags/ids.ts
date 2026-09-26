// Deterministic ids: the same inputs always give the same id, so re-running
// detectors keeps flag ids (and anything attached to them, like an
// explanation), and a clip's file name tells whether it's already been cut.

import { createHash } from 'node:crypto';
import type { Flag } from '../../shared/flags';

/** 16 lowercase hex characters: 64 bits of SHA-256. */
export const ID_RE = /^[0-9a-f]{16}$/;

const hashId = (...parts: (string | number)[]): string => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

export const flagIdFor = (sessionId: string, source: Flag['source'], type: string, startMs: number, endMs: number): string =>
  hashId('flag', sessionId, source, type, startMs, endMs);

export const clipIdFor = (sessionId: string, startMs: number, endMs: number): string => hashId('clip', sessionId, startMs, endMs);
