export interface FillerWord {
  phrase: string;
  count: number;
  kind: "filler" | "repetition";
}

export class FillerAnalysisError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

const responseSchema = {
  type: "object",
  properties: {
    fillerWords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phrase: { type: "string" },
          count: { type: "integer" },
          kind: { type: "string", enum: ["filler", "repetition"] },
        },
        required: ["phrase", "count", "kind"],
      },
    },
  },
  required: ["fillerWords"],
};

function normalizeWords(text: string): string {
  return ` ${text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()} `;
}

export async function analyzeFillers(
  transcript: string,
  apiKey: string,
): Promise<FillerWord[]> {
  if (!transcript.trim()) return [];

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  const prompt = [
    "Analyze this practice speech transcript for filler language and accidental adjacent word repetitions.",
    "Examples of possible fillers include uh, um, er, like, honestly, you know, so, and basically; this list is not exhaustive.",
    "Use context. 'I like this' uses like meaningfully; 'I was, like, surprised' uses it as a filler. 'So' can introduce a logical conclusion, but can also be a filler in 'so basically uh'.",
    "For adjacent repetitions such as 'I I' or 'the the', return the repeated phrase with kind repetition.",
    "Group identical filler phrases, count their occurrences, and use kind filler. Do not include meaningful uses or words absent from the transcript. Return only the requested JSON.",
    "Transcript:",
    transcript,
  ].join("\n\n");

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseFormat: {
              text: { mimeType: "APPLICATION_JSON", schema: responseSchema },
            },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    throw new FillerAnalysisError(
      "Gemini could not be reached. Try again later.",
      502,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new FillerAnalysisError(
        "Gemini rejected the configured API key.",
        502,
      );
    }
    if (response.status === 429) {
      throw new FillerAnalysisError(
        "Gemini is rate limiting requests. Try again later.",
        503,
      );
    }
    throw new FillerAnalysisError(
      "Gemini could not analyze this transcript.",
      502,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new FillerAnalysisError(
      "Gemini returned an unreadable response.",
      502,
    );
  }

  const candidate =
    data &&
    typeof data === "object" &&
    "candidates" in data &&
    Array.isArray(data.candidates)
      ? data.candidates[0]
      : undefined;
  const parts = candidate?.content?.parts;
  const output = Array.isArray(parts)
    ? parts
        .map((part: { text?: unknown }) => part.text)
        .filter((text: unknown): text is string => typeof text === "string")
        .join("")
    : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new FillerAnalysisError(
      "Gemini returned invalid filler analysis.",
      502,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("fillerWords" in parsed) ||
    !Array.isArray(parsed.fillerWords)
  ) {
    throw new FillerAnalysisError(
      "Gemini returned invalid filler analysis.",
      502,
    );
  }

  const groundedTranscript = normalizeWords(transcript);
  const result: FillerWord[] = [];
  for (const item of parsed.fillerWords.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const { phrase, count, kind } = item as Record<string, unknown>;
    if (
      typeof phrase !== "string" ||
      !phrase.trim() ||
      phrase.length > 80 ||
      !Number.isInteger(count) ||
      (count as number) < 1 ||
      (count as number) > 10_000 ||
      (kind !== "filler" && kind !== "repetition")
    )
      continue;
    const groundedPhrase = normalizeWords(phrase);
    if (!groundedPhrase.trim()) continue;
    const occurrences = groundedTranscript.split(groundedPhrase).length - 1;
    if (!occurrences) continue;
    const existing = result.find(
      (entry) =>
        entry.kind === kind && normalizeWords(entry.phrase) === groundedPhrase,
    );
    if (existing)
      existing.count = Math.min(
        occurrences,
        existing.count + (count as number),
      );
    else
      result.push({
        phrase: phrase.trim(),
        count: Math.min(occurrences, count as number),
        kind,
      });
  }
  return result;
}
