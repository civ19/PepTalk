import { describe, expect, it, vi } from "vitest";
import request from "supertest";

// Keep the repo's real .env (API keys, DATABASE_URL) out of this test.
vi.hoisted(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SMARTSPECTRA_API_KEY;
});
vi.mock("../src/env", () => ({ loadRootEnv: () => undefined }));
import handler from "../../api/index";

// Vercel calls the default export as handler(req, res); supertest does the same.
describe("Vercel function (api/index.ts)", () => {
  it("answers API requests instead of leaving them pending", async () => {
    const analysis = await request(handler)
      .post("/api/filler-analysis")
      .send({ transcript: "um" })
      .timeout(5_000);
    expect(analysis.status).toBe(503);

    const vitals = await request(handler)
      .post("/api/vitals")
      .set("Content-Type", "video/webm")
      .send(Buffer.from("video"))
      .timeout(5_000);
    expect(vitals.status).toBe(503);
    expect(vitals.body.error).toMatch(/SMARTSPECTRA_API_KEY/);
  });
});
