// Media files under the local media folder, addressed by object key (see
// objectKeys.ts) rather than by path. Tiger Data stores only the keys, so an
// S3-compatible store could serve the same keys later without schema changes.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { objectPath } from "./objectKeys";

export class LocalMediaStore {
  constructor(readonly root: string) {}

  /** Absolute path of an object, for tools that need a file (ffmpeg, res.sendFile). */
  pathOf(key: string): string {
    return objectPath(this.root, key);
  }

  /** Appends bytes, creating the object and its folders if needed. */
  async append(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.pathOf(key);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, bytes);
  }

  /** Size in bytes, or null if there is no such object. */
  async size(key: string): Promise<number | null> {
    try {
      const info = await stat(this.pathOf(key));
      return info.isFile() ? info.size : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Hex SHA-256 of the object's bytes. */
  async sha256(key: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(this.pathOf(key))) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }

  /** Renames an object, replacing whatever is at `to`. */
  async move(from: string, to: string): Promise<void> {
    await rename(this.pathOf(from), this.pathOf(to));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** Deletes every object under `prefix`, e.g. a session's folder. */
  async deletePrefix(prefix: string): Promise<void> {
    // Retries cover Windows briefly locking a file (antivirus, a player still reading it).
    await rm(this.pathOf(prefix), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}
