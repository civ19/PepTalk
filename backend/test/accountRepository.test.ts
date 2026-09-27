import { describe, expect, it } from "vitest";
import { AccountRepository } from "../src/modules/persistence/accountRepository";
import { migratedDb } from "./helpers";

describe("AccountRepository", () => {
  it("keeps projects and preparations scoped to the signed-in user and cascades deletion", async () => {
    const db = await migratedDb();
    const repo = new AccountRepository(db);
    await repo.saveProfile("auth0|alice", {
      name: "Alice",
      email: "a@example.test",
      picture: "",
    });
    await repo.saveProfile("google-oauth2|bob", {
      name: "Bob",
      email: "b@example.test",
      picture: "",
    });
    const project = {
      id: "shared-id",
      name: "Interview",
      category: "Interview",
      createdAt: "2026-09-27T12:00:00Z",
    };
    await repo.saveProject("auth0|alice", project);
    expect(
      await repo.savePreparation("google-oauth2|bob", {
        id: "attempt-1",
        projectId: project.id,
        createdAt: project.createdAt,
      }),
    ).toBe(false);
    expect(
      await repo.savePreparation("auth0|alice", {
        id: "attempt-1",
        projectId: project.id,
        createdAt: project.createdAt,
        transcript: "hello",
      }),
    ).toBe(true);
    expect((await repo.load("google-oauth2|bob")).preparations).toEqual([]);
    expect((await repo.load("auth0|alice")).preparations[0].transcript).toBe(
      "hello",
    );
    await repo.deleteProject("auth0|alice", project.id);
    expect((await repo.load("auth0|alice")).preparations).toEqual([]);
  });
});
