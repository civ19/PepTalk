import type { PracticeSession } from "../types/interview";

const SESSION_KEY = "preptalk.sessions.v1";

export function getSessions(): PracticeSession[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(SESSION_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as PracticeSession[]) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: PracticeSession[]): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init.method} ${url} failed with ${response.status}`);
  }
  return response;
}

/** Starts a recording on the backend and returns its session id. */
export async function createRecordingSession(): Promise<string> {
  const response = await send("/api/sessions", { method: "POST" });
  const { id } = (await response.json()) as { id: string };
  return id;
}

/** Appends one MediaRecorder chunk to the session's video on this computer. */
export async function appendRecording(
  id: string,
  chunk: Blob,
  mimeType: string,
): Promise<void> {
  await send(`/api/sessions/${id}/recording`, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: chunk,
  });
}

/** Makes the uploaded video seekable and records it in Tiger Data. */
export async function finishRecording(id: string): Promise<void> {
  await send(`/api/sessions/${id}/finish`, { method: "POST" });
}

/** Served with Range support, so it works directly as a <video> src. */
export function recordingUrl(id: string): string {
  return `/api/sessions/${id}/recording`;
}

/** The whole video, or undefined if it isn't stored on this computer. */
export async function getRecording(id: string): Promise<Blob | undefined> {
  const response = await fetch(recordingUrl(id));
  if (response.status === 404 || response.status === 409) return undefined;
  if (!response.ok) {
    throw new Error(`GET ${recordingUrl(id)} failed with ${response.status}`);
  }
  return response.blob();
}

export async function deleteRecording(id: string): Promise<void> {
  await send(`/api/sessions/${id}`, { method: "DELETE" });
}
