export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface TranscriptResult {
  text: string;
  languageCode: string | null;
}

export async function transcribeRecording(
  media: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<TranscriptResult> {
  const extension = mimeType === "video/mp4" ? "mp4" : "webm";
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("tag_audio_events", "false");
  form.append(
    "file",
    new Blob([new Uint8Array(media)], { type: mimeType }),
    `practice.${extension}`,
  );

  let response: Response;
  try {
    response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new TranscriptionError(
      "ElevenLabs could not be reached. Try again later.",
      502,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionError(
        "ElevenLabs rejected the configured API key.",
        502,
      );
    }
    if (response.status === 429) {
      throw new TranscriptionError(
        "ElevenLabs is rate limiting requests. Try again later.",
        503,
      );
    }
    throw new TranscriptionError(
      "ElevenLabs could not transcribe this recording.",
      502,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TranscriptionError(
      "ElevenLabs returned an unreadable transcript.",
      502,
    );
  }
  if (
    !data ||
    typeof data !== "object" ||
    !("text" in data) ||
    typeof data.text !== "string"
  ) {
    throw new TranscriptionError(
      "ElevenLabs returned an invalid transcript.",
      502,
    );
  }
  const languageCode =
    "language_code" in data && typeof data.language_code === "string"
      ? data.language_code
      : null;
  return { text: data.text, languageCode };
}
