import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import createApp from "../src/app";
import type { SqlClient } from "../src/modules/persistence/database";
import { TigerDataRepository } from "../src/modules/persistence/tigerDataRepository";
import { LocalMediaStore } from "../src/modules/storage/mediaStore";
import { RecordingService } from "../src/modules/storage/recordingService";
import { migratedDb, tempDir } from "./helpers";

describe("/api/sessions", () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await migratedDb();
  });

  const app = () =>
    createApp(
      new RecordingService(
        new TigerDataRepository(db),
        new LocalMediaStore(tempDir()),
        randomUUID(),
        {
          remux: (input, output) => copyFile(input, output),
          probeDurationMs: async () => null,
        },
      ),
    );

  it("answers 503 when Tiger Data isn't configured", async () => {
    const res = await request(createApp(null))
      .post("/api/sessions")
      .expect(503);
    expect(res.body.error).toMatch(/DATABASE_URL/);
  });

  it("records a session, streams it with Range requests, and deletes it", async () => {
    const server = app();
    const { body: session } = await request(server)
      .post("/api/sessions")
      .expect(201);
    const recording = `/api/sessions/${session.id}/recording`;
    for (const chunk of ["01234", "56789"]) {
      await request(server)
        .put(recording)
        .set("Content-Type", "video/webm;codecs=vp9,opus")
        .send(Buffer.from(chunk))
        .expect(204);
    }

    const { body: media } = await request(server)
      .post(`/api/sessions/${session.id}/finish`)
      .expect(200);
    expect(media).toMatchObject({
      objectKey: `sessions/${session.id}/recording.webm`,
      byteSize: 10,
      status: "ready",
    });

    const full = await request(server).get(recording).expect(200);
    expect(full.headers["content-type"]).toBe("video/webm");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.body.toString()).toBe("0123456789");

    const part = await request(server)
      .get(recording)
      .set("Range", "bytes=2-5")
      .expect(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(part.body.toString()).toBe("2345");

    await request(server).delete(`/api/sessions/${session.id}`).expect(204);
    await request(server).get(recording).expect(404);
  });

  it("rejects chunks that aren't video and ids that aren't sessions", async () => {
    const server = app();
    const { body: session } = await request(server)
      .post("/api/sessions")
      .expect(201);
    await request(server)
      .put(`/api/sessions/${session.id}/recording`)
      .set("Content-Type", "text/plain")
      .send("hello")
      .expect(415);
    await request(server)
      .put(`/api/sessions/${randomUUID()}/recording`)
      .set("Content-Type", "video/webm")
      .send(Buffer.from("x"))
      .expect(404);
    await request(server)
      .get("/api/sessions/not-a-session/recording")
      .expect(404);
    await request(server)
      .post(`/api/sessions/${session.id}/finish`)
      .expect(409);
  });
});
