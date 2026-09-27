import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SqlClient } from "../src/modules/persistence/database";
import { runMigrations } from "../src/modules/persistence/migrations";
import {
  TigerDataRepository,
  type MediaObject,
} from "../src/modules/persistence/tigerDataRepository";
import {
  parseDurationMs,
  probeDurationMs,
  remux,
  runFfmpeg,
} from "../src/modules/storage/ffmpeg";
import {
  readDeviceId,
  resolveMediaRoot,
} from "../src/modules/storage/mediaRoot";
import { LocalMediaStore } from "../src/modules/storage/mediaStore";
import {
  objectPath,
  rawRecordingKey,
  recordingKey,
} from "../src/modules/storage/objectKeys";
import {
  RecordingService,
  type MediaTools,
} from "../src/modules/storage/recordingService";
import { migratedDb, pgliteClient, tempDir } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("media folder", () => {
  it("defaults to the per-user app-data folder on each OS", () => {
    const winHome = "C:\\Users\\ada";
    expect(
      resolveMediaRoot({ LOCALAPPDATA: "D:\\Local" }, "win32", winHome),
    ).toBe("D:\\Local\\PrepTalk\\media");
    expect(resolveMediaRoot({}, "win32", winHome)).toBe(
      "C:\\Users\\ada\\AppData\\Local\\PrepTalk\\media",
    );
    expect(resolveMediaRoot({}, "darwin", "/Users/ada")).toBe(
      "/Users/ada/Library/Application Support/PrepTalk/media",
    );
    expect(resolveMediaRoot({}, "linux", "/home/ada")).toBe(
      "/home/ada/.local/share/PrepTalk/media",
    );
    expect(
      resolveMediaRoot({ XDG_DATA_HOME: "/data" }, "linux", "/home/ada"),
    ).toBe("/data/PrepTalk/media");
  });

  it("uses PREPTALK_MEDIA_DIR when it's set", () => {
    const dir = tempDir();
    expect(
      resolveMediaRoot({ PREPTALK_MEDIA_DIR: dir }, "darwin", "/Users/ada"),
    ).toBe(dir);
    // PREPTALK_MEDIA_DIR= left empty in .env keeps the default.
    expect(
      resolveMediaRoot({ PREPTALK_MEDIA_DIR: " " }, "darwin", "/Users/ada"),
    ).toBe("/Users/ada/Library/Application Support/PrepTalk/media");
  });

  it("creates the device id once, inside the folder", async () => {
    const root = join(tempDir(), "media");
    const id = await readDeviceId(root);
    expect(id).toMatch(UUID);
    await expect(readDeviceId(root)).resolves.toBe(id);
    expect(
      JSON.parse(await readFile(join(root, "device.json"), "utf8")),
    ).toEqual({ id });
  });
});

describe("object keys", () => {
  it("are relative and resolve with this OS's separators", () => {
    const id = randomUUID();
    expect(recordingKey(id, "webm")).toBe(`sessions/${id}/recording.webm`);
    expect(rawRecordingKey(id, "mp4")).toBe(`sessions/${id}/recording.raw.mp4`);
    const root = tempDir();
    expect(objectPath(root, recordingKey(id, "webm"))).toBe(
      join(root, "sessions", id, "recording.webm"),
    );
  });

  it.each([
    "",
    "../outside.webm",
    "sessions/../x.webm",
    "/absolute.webm",
    "C:/x.webm",
    "sessions\\x.webm",
    "Sessions/x.webm",
    "sessions//x.webm",
  ])("rejects %j", (key) => {
    expect(() => objectPath(tmpdir(), key)).toThrow("invalid object key");
  });

  it("only accept UUID session ids", () => {
    expect(() => recordingKey("../../etc", "webm")).toThrow(
      "invalid session id",
    );
  });
});

describe("LocalMediaStore", () => {
  it("appends in order, then hashes, moves and deletes by key", async () => {
    const store = new LocalMediaStore(tempDir());
    const id = randomUUID();
    const raw = rawRecordingKey(id, "webm");
    expect(await store.size(raw)).toBeNull();
    await store.append(raw, Buffer.from("hello "));
    await store.append(raw, Buffer.from("world"));
    expect(await readFile(store.pathOf(raw), "utf8")).toBe("hello world");
    expect(await store.size(raw)).toBe(11);
    expect(await store.sha256(raw)).toBe(sha256("hello world"));

    const key = recordingKey(id, "webm");
    await store.move(raw, key);
    expect(await store.size(raw)).toBeNull();
    expect(await store.size(key)).toBe(11);

    await store.deletePrefix(`sessions/${id}`);
    expect(await store.size(key)).toBeNull();
  });
});

describe("ffmpeg", () => {
  it("reads the duration from ffmpeg's banner", () => {
    expect(
      parseDurationMs(
        "  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s",
      ),
    ).toBe(62_500);
    expect(parseDurationMs("  Duration: N/A, start: 0.000000")).toBeNull();
  });

  it.skipIf(!ffmpegPath || !existsSync(ffmpegPath))(
    "remuxes a WebM with the bundled binary",
    async () => {
      const dir = tempDir();
      const input = join(dir, "recording.raw.webm");
      const made = await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=64x64:rate=10",
        "-c:v",
        "libvpx",
        input,
      ]);
      expect(made.code, made.stderr).toBe(0);
      const output = join(dir, "recording.webm");
      await remux(input, output);
      const durationMs = await probeDurationMs(output);
      expect(durationMs).toBeGreaterThanOrEqual(900);
      expect(durationMs).toBeLessThanOrEqual(1100);
    },
    30_000,
  );
});

describe("TigerDataRepository", () => {
  let db: SqlClient;
  let repository: TigerDataRepository;

  beforeAll(async () => {
    db = await migratedDb();
    repository = new TigerDataRepository(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE practice_sessions CASCADE");
  });

  const recording = (
    sessionId: string,
    patch: Partial<MediaObject> = {},
  ): MediaObject => ({
    id: randomUUID(),
    sessionId,
    kind: "recording",
    storage: "local",
    objectKey: `sessions/${sessionId}/recording.webm`,
    deviceId: randomUUID(),
    mimeType: "video/webm",
    byteSize: 1234,
    sha256: sha256("video"),
    durationMs: 1500,
    status: "ready",
    ...patch,
  });

  it("applies each migration once", async () => {
    const client = pgliteClient();
    const quiet = (): void => undefined;
    expect(await runMigrations(client, undefined, quiet)).toEqual([
      "001_media_objects.sql",
    ]);
    expect(await runMigrations(client, undefined, quiet)).toEqual([]);
  });

  it("records a finished recording and marks its session complete", async () => {
    const sessionId = randomUUID();
    await repository.createSession(sessionId);
    const media = recording(sessionId);
    expect(await repository.completeSession(media)).toEqual(media);
    expect(await repository.findRecording(sessionId)).toEqual(media);
    const { rows } = await db.query(
      "SELECT status, completed_at FROM practice_sessions WHERE id = $1",
      [sessionId],
    );
    expect(rows[0].status).toBe("complete");
    expect(rows[0].completed_at).toBeInstanceOf(Date);
  });

  it("updates the same row when a recording is finished again", async () => {
    const sessionId = randomUUID();
    await repository.createSession(sessionId);
    const first = recording(sessionId);
    await repository.completeSession(first);
    const again = await repository.completeSession(
      recording(sessionId, { byteSize: 99 }),
    );
    expect(again).toMatchObject({ id: first.id, byteSize: 99 });
  });

  it("records nothing for a session that doesn't exist", async () => {
    const sessionId = randomUUID();
    expect(await repository.completeSession(recording(sessionId))).toBeNull();
    expect(await repository.findRecording(sessionId)).toBeNull();
  });

  it("lists one device's local media and updates its status", async () => {
    const deviceId = randomUUID();
    const mine = recording(randomUUID(), { deviceId });
    const theirs = recording(randomUUID());
    for (const media of [mine, theirs]) {
      await repository.createSession(media.sessionId);
      await repository.completeSession(media);
    }
    expect(await repository.listLocalMedia(deviceId)).toEqual([mine]);
    await repository.setMediaStatus([mine.id], "missing");
    expect(await repository.findRecording(mine.sessionId)).toMatchObject({
      status: "missing",
    });
  });

  it("deletes a session together with its media rows", async () => {
    const sessionId = randomUUID();
    await repository.createSession(sessionId);
    await repository.completeSession(recording(sessionId));
    await repository.deleteSession(sessionId);
    expect(await repository.sessionExists(sessionId)).toBe(false);
    expect(await repository.findRecording(sessionId)).toBeNull();
  });
});

describe("RecordingService", () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stands in for ffmpeg: "remuxing" copies the file. */
  const copyTools: MediaTools = {
    remux: (input, output) => copyFile(input, output),
    probeDurationMs: async () => 1500,
  };

  function setup(tools: MediaTools = copyTools) {
    const store = new LocalMediaStore(tempDir());
    const deviceId = randomUUID();
    const repository = new TigerDataRepository(db);
    const service = new RecordingService(repository, store, deviceId, tools);
    return { store, deviceId, service };
  }

  async function record(
    service: RecordingService,
    ...chunks: string[]
  ): Promise<string> {
    const id = await service.createSession();
    for (const chunk of chunks) {
      await service.append(
        id,
        "video/webm;codecs=vp9,opus",
        Buffer.from(chunk),
      );
    }
    return id;
  }

  it("stores the video in the media folder and only its key in Tiger Data", async () => {
    const { store, deviceId, service } = setup();
    const id = await record(service, "chunk-1 ", "chunk-2");
    const media = await service.finish(id);
    expect(media).toMatchObject({
      sessionId: id,
      kind: "recording",
      storage: "local",
      objectKey: `sessions/${id}/recording.webm`,
      deviceId,
      mimeType: "video/webm",
      byteSize: 15,
      sha256: sha256("chunk-1 chunk-2"),
      durationMs: 1500,
      status: "ready",
    });
    expect(await readFile(store.pathOf(media.objectKey), "utf8")).toBe(
      "chunk-1 chunk-2",
    );
    expect(await store.size(rawRecordingKey(id, "webm"))).toBeNull();
    await expect(service.recordingFile(id)).resolves.toEqual({
      root: store.root,
      key: media.objectKey,
    });
    // Finishing again (a retried request) keeps the same row.
    await expect(service.finish(id)).resolves.toMatchObject({ id: media.id });
  });

  it("keeps the video as recorded when remuxing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noFfmpeg = () => Promise.reject(new Error("no ffmpeg"));
    const { store, service } = setup({
      remux: noFfmpeg,
      probeDurationMs: noFfmpeg,
    });
    const id = await record(service, "as recorded");
    const media = await service.finish(id);
    expect(media).toMatchObject({
      objectKey: `sessions/${id}/recording.webm`,
      durationMs: null,
    });
    expect(await readFile(store.pathOf(media.objectKey), "utf8")).toBe(
      "as recorded",
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("refuses unknown sessions, other video types and empty recordings", async () => {
    const { service } = setup();
    const chunk = Buffer.from("x");
    await expect(
      service.append(randomUUID(), "video/webm", chunk),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.append("../../x", "video/webm", chunk),
    ).rejects.toMatchObject({ status: 404 });
    const id = await service.createSession();
    await expect(
      service.append(id, "video/quicktime", chunk),
    ).rejects.toMatchObject({ status: 415 });
    await expect(service.finish(id)).rejects.toMatchObject({ status: 409 });
  });

  it("won't stream a recording stored on another device", async () => {
    const recorder = setup();
    const id = await record(recorder.service, "video");
    await recorder.service.finish(id);
    await expect(setup().service.recordingFile(id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("marks a vanished file missing, and ready again when it returns", async () => {
    const { store, service } = setup();
    const id = await record(service, "video");
    const { objectKey } = await service.finish(id);
    const bytes = await readFile(store.pathOf(objectKey));

    await store.delete(objectKey);
    expect(await service.reconcile()).toEqual({ missing: 1, restored: 0 });
    await expect(service.recordingFile(id)).rejects.toMatchObject({
      status: 404,
    });

    await writeFile(store.pathOf(objectKey), bytes);
    expect(await service.reconcile()).toEqual({ missing: 0, restored: 1 });
    await expect(service.recordingFile(id)).resolves.toMatchObject({
      key: objectKey,
    });
  });

  it("deletes the session's folder and rows", async () => {
    const { store, service } = setup();
    const id = await record(service, "video");
    const { objectKey } = await service.finish(id);
    await service.delete(id);
    expect(await store.size(objectKey)).toBeNull();
    await expect(service.recordingFile(id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
