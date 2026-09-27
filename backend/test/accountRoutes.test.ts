import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AccountRepository } from "../src/modules/persistence/accountRepository";
import accountRoutes from "../src/routes/accountRoutes";
import { migratedDb } from "./helpers";

describe("account routes", () => {
  it("explains a database connection timeout during account loading", async () => {
    const repo = new AccountRepository({
      query: async () => {
        throw new Error("timeout expired");
      },
    });
    const app = express();
    app.use(
      accountRoutes(repo, (req, _res, next) => {
        Object.assign(req, { auth: { payload: { sub: "alice" } } });
        next();
      }),
    );
    const response = await request(app).get("/").expect(503);
    expect(response.body.error).toContain("Tiger Data connection timed out");
  });

  it("uses the verified request subject and rejects preparations under another account's project", async () => {
    const repo = new AccountRepository(await migratedDb());
    const app = express();
    app.use(express.json());
    app.use(
      accountRoutes(repo, (req, _res, next) => {
        const sub = req.header("x-test-sub");
        if (sub) Object.assign(req, { auth: { payload: { sub } } });
        next();
      }),
    );
    const project = {
      id: "project-1",
      name: "Practice",
      category: "Interview",
      createdAt: "2026-09-27T12:00:00Z",
    };
    await request(app)
      .put("/profile")
      .set("x-test-sub", "alice")
      .send({ name: "Alice", email: "a@example.test", picture: "" })
      .expect(204);
    await request(app)
      .put("/profile")
      .set("x-test-sub", "bob")
      .send({ name: "Bob", email: "b@example.test", picture: "" })
      .expect(204);
    await request(app)
      .put("/projects/project-1")
      .set("x-test-sub", "alice")
      .send(project)
      .expect(204);
    await request(app)
      .put("/preparations/run-1")
      .set("x-test-sub", "bob")
      .send({
        id: "run-1",
        projectId: project.id,
        createdAt: project.createdAt,
      })
      .expect(404);
    await request(app)
      .get("/")
      .set("x-test-sub", "bob")
      .expect(200)
      .then(({ body }) => {
        expect(body.projects).toEqual([]);
        expect(body.preparations).toEqual([]);
      });
    await request(app).get("/").expect(401);
  });
});
