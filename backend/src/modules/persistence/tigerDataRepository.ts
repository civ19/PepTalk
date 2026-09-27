// Tiger Data rows for practice sessions and their media files. Schema:
// backend/db/migrations/001_media_objects.sql (npm run db:migrate).

import type { SqlClient } from "./database";

export type MediaKind = "recording" | "clip" | "thumbnail";
export type MediaStatus = "writing" | "ready" | "missing";

export interface MediaObject {
  id: string;
  sessionId: string;
  kind: MediaKind;
  storage: "local" | "s3";
  /** Relative to the media folder, e.g. 'sessions/<uuid>/recording.webm'. */
  objectKey: string;
  /** The media folder holding a 'local' object (see mediaRoot.ts). */
  deviceId: string | null;
  mimeType: string;
  byteSize: number | null;
  sha256: string | null;
  durationMs: number | null;
  status: MediaStatus;
}

interface MediaRow {
  id: string;
  session_id: string;
  kind: MediaKind;
  storage: "local" | "s3";
  object_key: string;
  device_id: string | null;
  mime_type: string;
  /** pg returns bigint as a string. */
  byte_size: string | number | null;
  sha256: string | null;
  duration_ms: number | null;
  status: MediaStatus;
}

const MEDIA_COLUMNS =
  "id, session_id, kind, storage, object_key, device_id, mime_type, byte_size, sha256, duration_ms, status";

const toMediaObject = (row: MediaRow): MediaObject => ({
  id: row.id,
  sessionId: row.session_id,
  kind: row.kind,
  storage: row.storage,
  objectKey: row.object_key,
  deviceId: row.device_id,
  mimeType: row.mime_type,
  byteSize: row.byte_size === null ? null : Number(row.byte_size),
  sha256: row.sha256,
  durationMs: row.duration_ms,
  status: row.status,
});

export class TigerDataRepository {
  constructor(private readonly db: SqlClient) {}

  async createSession(id: string): Promise<void> {
    await this.db.query(
      "INSERT INTO practice_sessions (id, status) VALUES ($1, 'recording')",
      [id],
    );
  }

  async sessionExists(id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      "SELECT 1 FROM practice_sessions WHERE id = $1",
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Records a session's finished media file and marks the session complete,
   * in one statement so neither happens without the other. Finishing again
   * updates the same row. Null if the session doesn't exist.
   */
  async completeSession(media: MediaObject): Promise<MediaObject | null> {
    const { rows } = await this.db.query(
      `WITH session AS (
         UPDATE practice_sessions SET status = 'complete', completed_at = coalesce(completed_at, now())
         WHERE id = $2 RETURNING id
       )
       INSERT INTO media_objects (${MEDIA_COLUMNS})
       SELECT $1, session.id, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM session
       ON CONFLICT (storage, object_key) DO UPDATE SET
         device_id = EXCLUDED.device_id, mime_type = EXCLUDED.mime_type, byte_size = EXCLUDED.byte_size,
         sha256 = EXCLUDED.sha256, duration_ms = EXCLUDED.duration_ms, status = EXCLUDED.status
       RETURNING ${MEDIA_COLUMNS}`,
      [
        media.id,
        media.sessionId,
        media.kind,
        media.storage,
        media.objectKey,
        media.deviceId,
        media.mimeType,
        media.byteSize,
        media.sha256,
        media.durationMs,
        media.status,
      ],
    );
    return rows.length ? toMediaObject(rows[0]) : null;
  }

  async findRecording(sessionId: string): Promise<MediaObject | null> {
    const { rows } = await this.db.query(
      `SELECT ${MEDIA_COLUMNS} FROM media_objects
       WHERE session_id = $1 AND kind = 'recording'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    return rows.length ? toMediaObject(rows[0]) : null;
  }

  /** Deletes the session; its media_objects rows go with it (ON DELETE CASCADE). */
  async deleteSession(id: string): Promise<void> {
    await this.db.query("DELETE FROM practice_sessions WHERE id = $1", [id]);
  }

  /** Every 'local' object stored in the media folder with this device id. */
  async listLocalMedia(deviceId: string): Promise<MediaObject[]> {
    const { rows } = await this.db.query(
      `SELECT ${MEDIA_COLUMNS} FROM media_objects WHERE storage = 'local' AND device_id = $1`,
      [deviceId],
    );
    return rows.map(toMediaObject);
  }

  async setMediaStatus(
    ids: readonly string[],
    status: MediaStatus,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      "UPDATE media_objects SET status = $2 WHERE id = ANY($1::uuid[])",
      [ids, status],
    );
  }
}
