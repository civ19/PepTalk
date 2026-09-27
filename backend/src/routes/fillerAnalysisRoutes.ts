import { Router } from "express";
import {
  analyzeFillers,
  FillerAnalysisError,
} from "../modules/gemini/fillerAnalysisService";

const router = Router();

router.post("/", async (req, res) => {
  const transcript = req.body?.transcript;
  if (
    typeof transcript !== "string" ||
    !transcript.trim() ||
    transcript.length > 100_000
  ) {
    res
      .status(400)
      .json({ error: "Send a transcript between 1 and 100,000 characters." });
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    res.status(503).json({
      error: "Gemini is not configured. Set GEMINI_API_KEY on the backend.",
    });
    return;
  }
  try {
    res.json({ fillerWords: await analyzeFillers(transcript, apiKey) });
  } catch (error) {
    if (error instanceof FillerAnalysisError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(502).json({ error: "Filler analysis failed. Try again later." });
  }
});

export default router;
