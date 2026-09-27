import { Router, raw } from "express";
import {
  transcribeRecording,
  TranscriptionError,
} from "../modules/elevenlabs/transcriptionService";
import {
  analyzeFillers,
  FillerAnalysisError,
} from "../modules/gemini/fillerAnalysisService";

const router = Router();
const allowedTypes = new Set(["video/webm", "video/mp4"]);

router.post(
  "/",
  raw({ type: ["video/webm", "video/mp4"], limit: "50mb" }),
  async (req, res) => {
    const mimeType =
      req.header("content-type")?.split(";")[0].toLowerCase() ?? "";
    if (!allowedTypes.has(mimeType)) {
      res.status(415).json({ error: "Send a WebM or MP4 recording." });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "The recording is empty." });
      return;
    }
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        error:
          "ElevenLabs is not configured. Set ELEVENLABS_API_KEY on the backend.",
      });
      return;
    }
    try {
      const transcript = await transcribeRecording(req.body, mimeType, apiKey);
      const geminiKey = process.env.GEMINI_API_KEY?.trim();
      if (!geminiKey) {
        res.json({
          ...transcript,
          fillerWords: null,
          analysisError:
            "Gemini is not configured. Set GEMINI_API_KEY on the backend.",
        });
        return;
      }
      try {
        const fillerWords = await analyzeFillers(transcript.text, geminiKey);
        res.json({ ...transcript, fillerWords });
      } catch (error) {
        const analysisError =
          error instanceof FillerAnalysisError
            ? error.message
            : "Gemini filler analysis failed. Try again later.";
        res.json({ ...transcript, fillerWords: null, analysisError });
      }
    } catch (error) {
      if (error instanceof TranscriptionError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(502).json({ error: "Transcription failed. Try again later." });
    }
  },
);

export default router;
