import { describe, expect, it } from "vitest";
import type { PracticeSession } from "../src/types/interview";
import {
  projectIdFor,
  projectsFor,
  sessionsInProject,
} from "../src/utils/projects";
import { trendFor } from "../src/utils/trends";

const run = (
  id: string,
  values: Partial<PracticeSession> = {},
): PracticeSession => ({
  id,
  title: "School presentation",
  category: "Presentation",
  createdAt: `2026-09-${id.padStart(2, "0")}T12:00:00.000Z`,
  durationSeconds: 60,
  transcript: "practice words",
  wordCount: 100,
  wordsPerMinute: 100,
  fillerCount: 3,
  hasRecording: true,
  ...values,
});

describe("project folders", () => {
  it("groups older sessions by normalized name and type without changing them", () => {
    const old = run("1");
    const repeated = run("2", { title: " school  presentation " });
    const interview = run("3", { category: "Interview" });
    const projects = projectsFor([old, repeated, interview], []);
    expect(projects).toHaveLength(2);
    expect(projectIdFor(old)).toBe(projectIdFor(repeated));
    expect(
      sessionsInProject([old, repeated, interview], projectIdFor(old)),
    ).toHaveLength(2);
  });

  it("keeps explicit projects separate even when run titles match", () => {
    expect(projectIdFor(run("1", { projectId: "one" }))).not.toBe(
      projectIdFor(run("2", { projectId: "two" })),
    );
  });
});

describe("project trends", () => {
  it("skips missing values and extreme spikes while connecting valid attempts", () => {
    const sessions = [3, 4, 3, 4, 100, 2].map((fillerCount, index) =>
      run(String(index + 1), { fillerCount }),
    );
    sessions[2].wordCount = 0;
    const points = trendFor(sessions, "fillers");
    expect(points.map((point) => point.attempt)).toEqual([1, 2, 4, 6]);
    expect(points.map((point) => point.value)).toEqual([3, 4, 4, 2]);
    expect(sessions[4].fillerCount).toBe(100);
  });
});
