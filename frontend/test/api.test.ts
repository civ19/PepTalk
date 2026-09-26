import { describe, expect, it, vi } from "vitest";
import { ApiError, startSession } from "../src/services/api";

describe("startSession", () => {
  it("POSTs the topic to /api/sessions and returns the session", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "abc-123" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await startSession("System design");

    expect(session).toEqual({ id: "abc-123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/sessions");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ topic: "System design" }));
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("throws an ApiError carrying the status when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
    );

    const error: unknown = await startSession("System design").catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 503,
      message: "Request to /sessions failed with status 503",
    });
  });
});
