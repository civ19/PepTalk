import type { PracticeProject, PracticeSession } from "../types/interview";

const normalized = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, " ");

/** Existing sessions had no folder. Keep their old title-and-type grouping stable. */
export function projectIdFor(session: PracticeSession): string {
  return (
    session.projectId ??
    `legacy:${session.category.toLowerCase()}:${encodeURIComponent(normalized(session.title))}`
  );
}

export function projectsFor(
  sessions: PracticeSession[],
  saved: PracticeProject[],
): PracticeProject[] {
  const projects = new Map(saved.map((project) => [project.id, project]));
  for (const session of [...sessions].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    const id = projectIdFor(session);
    if (!projects.has(id)) {
      projects.set(id, {
        id,
        name: session.title.trim() || "Untitled practice",
        category: session.category,
        createdAt: session.createdAt,
      });
    }
  }
  return [...projects.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function sessionsInProject(
  sessions: PracticeSession[],
  projectId: string,
): PracticeSession[] {
  return sessions.filter((session) => projectIdFor(session) === projectId);
}
