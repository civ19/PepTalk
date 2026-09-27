import type {
  FillerWord,
  CoachingFeedback,
  CoachingReport,
  PracticeProject,
  PracticeSession,
  ProjectFile,
  TimedWord,
  VitalsResult,
} from "../types/interview";
import { confidenceFor, reliable } from "../utils/confidence";

const SESSION_KEY = "preptalk.sessions.v1";
const PROJECT_KEY = "preptalk.projects.v1";
const DB_NAME = "preptalk-recordings";
const STORE_NAME = "recordings";
const FILE_STORE = "project-files";

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

export function getSavedProjects(): PracticeProject[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PROJECT_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as PracticeProject[]) : [];
  } catch {
    return [];
  }
}

export function saveProjects(projects: PracticeProject[]): void {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(projects));
}

function openRecordingDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(FILE_STORE)) {
        request.result.createObjectStore(FILE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProjectFile(file: File): Promise<ProjectFile> {
  const extension = file.name.toLowerCase().split(".").at(-1);
  const type =
    extension === "pdf"
      ? "application/pdf"
      : extension === "csv"
        ? "text/csv"
        : extension === "md"
          ? "text/markdown"
          : "text/plain";
  const metadata: ProjectFile = {
    id: crypto.randomUUID(),
    name: file.name,
    type,
    size: file.size,
  };
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(FILE_STORE, "readwrite");
      transaction.objectStore(FILE_STORE).put(file, metadata.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
  return metadata;
}

export async function getProjectFile(id: string): Promise<Blob | undefined> {
  const db = await openRecordingDb();
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db
        .transaction(FILE_STORE, "readonly")
        .objectStore(FILE_STORE)
        .get(id);
      request.onsuccess = () => resolve(request.result as Blob | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteProjectFile(id: string): Promise<void> {
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(FILE_STORE, "readwrite");
      transaction.objectStore(FILE_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRecording(id: string, blob: Blob): Promise<void> {
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(blob, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function getRecording(id: string): Promise<Blob | undefined> {
  const db = await openRecordingDb();
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(id);
      request.onsuccess = () => resolve(request.result as Blob | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Remove every locally stored recording, including orphaned videos. */
export async function deleteAllRecordings(): Promise<void> {
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export interface TranscriptionResult {
  text: string;
  timedWords: TimedWord[];
  fillerWords: FillerWord[] | null;
  analysisError?: string;
}

function parseFillerWords(value: unknown): FillerWord[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is FillerWord =>
      item &&
      typeof item === "object" &&
      typeof item.phrase === "string" &&
      Number.isInteger(item.count) &&
      item.count > 0 &&
      (item.kind === "filler" || item.kind === "repetition"),
  );
}

function responseError(result: unknown, status: number): Error {
  const message =
    result &&
    typeof result === "object" &&
    "error" in result &&
    typeof result.error === "string"
      ? result.error
      : status >= 500
        ? `Server request failed (${status}). Check that the backend is running and inspect its terminal output.`
        : // The local backend takes 50 MB (checked before sending), so this is a host's
          // limit, like Vercel's ~4 MB per request.
          status === 413
          ? "This recording is too large for the hosted server. Run PrepTalk locally (npm run dev) to analyze it."
          : `Request failed (${status}).`;
  return new Error(message);
}

export async function transcribeRecording(
  blob: Blob,
): Promise<TranscriptionResult> {
  const mimeType = blob.type.split(";")[0];
  if (blob.size > 50 * 1024 * 1024) {
    throw new Error(
      "This recording is too large to transcribe. Keep runs under 50 MB.",
    );
  }
  if (mimeType !== "video/webm" && mimeType !== "video/mp4") {
    throw new Error("This browser recorded an unsupported video format.");
  }

  let response: Response;
  try {
    response = await fetch("/api/transcriptions", {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: blob,
    });
  } catch {
    throw new Error(
      "The transcription server is unavailable. Your recording is still saved.",
    );
  }

  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw responseError(result, response.status);
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string"
  ) {
    throw new Error("The transcription server returned an invalid response.");
  }
  return {
    text: result.text,
    timedWords:
      "timedWords" in result && Array.isArray(result.timedWords)
        ? result.timedWords.filter(
            (word): word is TimedWord =>
              !!word &&
              typeof word === "object" &&
              typeof word.text === "string" &&
              typeof word.start === "number" &&
              typeof word.end === "number",
          )
        : [],
    fillerWords:
      "fillerWords" in result ? parseFillerWords(result.fillerWords) : null,
    analysisError:
      "analysisError" in result && typeof result.analysisError === "string"
        ? result.analysisError
        : undefined,
  };
}

function base64For(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Files remain on this device; only their content is sent for the requested analysis. */
export async function requestCoaching(
  project: PracticeProject,
  session: PracticeSession,
  previous: PracticeSession[],
): Promise<
  Omit<CoachingFeedback, "generatedAt"> & { persistenceError?: string }
> {
  const earlier = previous
    .filter((item) => item.id !== session.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const scored = earlier
    .map((item) => confidenceFor(item).score)
    .filter((score): score is number => score !== null);
  const attachments = await Promise.all(
    (project.files ?? []).map(async (file) => {
      const blob = await getProjectFile(file.id);
      if (!blob)
        throw new Error(
          `Project file “${file.name}” is missing from this browser.`,
        );
      return { name: file.name, type: file.type, data: await base64For(blob) };
    }),
  );
  let response: Response;
  try {
    response = await fetch("/api/coaching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: {
          id: project.id,
          name: project.name,
          category: project.category,
          contextNotes: project.contextNotes,
        },
        session: {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          attemptNumber: earlier.length + 1,
          category: session.category,
          durationSeconds: session.durationSeconds,
          transcript: session.transcript,
          wordsPerMinute: session.wordsPerMinute,
          fillerCount: session.fillerCount,
          fillerWords: session.fillerWords,
          timedWords: session.timedWords,
          vitals: session.vitals,
        },
        historySummary: {
          totalAttempts: earlier.length,
          totalMinutes: Math.round(
            earlier.reduce((sum, item) => sum + item.durationSeconds, 0) / 60,
          ),
          firstAttemptAt: earlier[0]?.createdAt ?? null,
          latestAttemptAt: earlier.at(-1)?.createdAt ?? null,
          firstConfidenceScore: scored[0] ?? null,
          latestConfidenceScore: scored.at(-1) ?? null,
          averageConfidenceScore: scored.length
            ? Math.round(
                scored.reduce((sum, score) => sum + score, 0) / scored.length,
              )
            : null,
          feedbackResponses: earlier.reduce(
            (sum, item) => sum + (item.feedbackHistory?.length ?? 0),
            0,
          ),
        },
        previousAttempts: earlier.slice(-20).map((item) => ({
          title: item.title,
          createdAt: item.createdAt,
          durationSeconds: item.durationSeconds,
          transcript: item.transcript.slice(0, 5000),
          wordsPerMinute: item.wordsPerMinute,
          fillerCount: item.fillerCount,
          confidenceScore: confidenceFor(item).score,
          vitalsSummary: {
            cameraFacingPercent: item.vitals?.cameraFacingPercent,
            possibleBreathInterruptions:
              item.vitals?.possibleBreathInterruptions,
            expressionShares: item.vitals?.expressionShares,
            pulse: summarizeReadings(reliable(item.vitals?.heartRate)),
            breathing: summarizeReadings(reliable(item.vitals?.breathingRate)),
          },
          feedback: item.feedbackHistory
            ?.slice(-20)
            .map((feedback) => feedback.report),
        })),
        earlierFeedbackForThisAttempt:
          session.feedbackHistory?.slice(-20).map((item) => item.report) ?? [],
        attachments,
      }),
    });
  } catch {
    throw new Error(
      "The Gemini coaching server is unavailable. Try again later.",
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (response.status === 413)
    throw new Error(
      "This coaching request is too large. Remove a reference file and try again.",
    );
  if (!response.ok) throw responseError(result, response.status);
  if (
    !result ||
    typeof result !== "object" ||
    !("report" in result) ||
    typeof result.report !== "object" ||
    !("rawResponse" in result) ||
    typeof result.rawResponse !== "string" ||
    !("id" in result) ||
    typeof result.id !== "string"
  )
    throw new Error("Gemini returned invalid coaching feedback.");
  return {
    id: result.id,
    report: result.report as CoachingReport,
    rawResponse: result.rawResponse,
    persistenceError:
      "persistenceError" in result &&
      typeof result.persistenceError === "string"
        ? result.persistenceError
        : undefined,
  };
}

function summarizeReadings(
  points: { value: number }[],
): { median: number; peak: number } | null {
  if (!points.length) return null;
  const sorted = points.map((point) => point.value).sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    peak: sorted.at(-1)!,
  };
}

export async function analyzeTranscript(
  transcript: string,
): Promise<FillerWord[]> {
  let response: Response;
  try {
    response = await fetch("/api/filler-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
  } catch {
    throw new Error("The analysis server is unavailable. Try again later.");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(result, response.status);
  const fillers =
    result && typeof result === "object" && "fillerWords" in result
      ? parseFillerWords(result.fillerWords)
      : null;
  if (!fillers)
    throw new Error("The analysis server returned an invalid response.");
  return fillers;
}

/** createdAt is stamped when recording stops, so the run started durationSeconds earlier. */
function sessionStartedAt(
  session: Pick<PracticeSession, "createdAt" | "durationSeconds">,
): string {
  const startedAt =
    Date.parse(session.createdAt) - session.durationSeconds * 1000;
  return Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : "";
}

export async function analyzeVitals(
  blob: Blob,
  session: Pick<PracticeSession, "id" | "createdAt" | "durationSeconds">,
): Promise<VitalsResult> {
  const mimeType = blob.type.split(";")[0];
  if (blob.size > 50 * 1024 * 1024)
    throw new Error(
      "This recording is too large for Presage analysis. Keep runs under 50 MB.",
    );
  if (mimeType !== "video/webm" && mimeType !== "video/mp4")
    throw new Error("This browser recorded an unsupported video format.");
  let response: Response;
  try {
    response = await fetch("/api/vitals", {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        // Lets the backend save the samples to Tiger Data under this session.
        "X-Session-Id": session.id,
        "X-Session-Started-At": sessionStartedAt(session),
      },
      body: blob,
    });
  } catch {
    throw new Error(
      "The Presage server is unavailable. Your recording is still saved.",
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(result, response.status);
  if (
    !result ||
    typeof result !== "object" ||
    !("heartRate" in result) ||
    !Array.isArray(result.heartRate) ||
    !("breathingRate" in result) ||
    !Array.isArray(result.breathingRate)
  )
    throw new Error("Presage returned an invalid response.");
  return result as VitalsResult;
}
