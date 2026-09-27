import type { PracticeProject, PracticeSession } from "../types/interview";

export interface AccountData {
  profile: { name: string; email: string; picture: string } | null;
  projects: PracticeProject[];
  preparations: PracticeSession[];
}

async function accountRequest(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`/api/account${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      result?.error ?? `Account request failed (${response.status}).`,
    );
  }
  return response;
}

export async function loadAccount(token: string): Promise<AccountData> {
  return (await accountRequest("/", token)).json();
}

export async function saveAccountProfile(
  token: string,
  profile: { name: string; email: string; picture: string },
) {
  await accountRequest("/profile", token, "PUT", profile);
}

export async function saveAccountProject(
  token: string,
  project: PracticeProject,
) {
  await accountRequest(
    `/projects/${encodeURIComponent(project.id)}`,
    token,
    "PUT",
    project,
  );
}

export async function saveAccountPreparation(
  token: string,
  preparation: PracticeSession,
) {
  await accountRequest(
    `/preparations/${encodeURIComponent(preparation.id)}`,
    token,
    "PUT",
    preparation,
  );
}

export async function deleteAccountPreparation(token: string, id: string) {
  await accountRequest(
    `/preparations/${encodeURIComponent(id)}`,
    token,
    "DELETE",
  );
}
