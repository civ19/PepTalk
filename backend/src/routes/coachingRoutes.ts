import { randomUUID } from "node:crypto";
import { Router, json } from "express";
import {
  analyzeCoaching,
  validateCoachingInput,
} from "../modules/gemini/coachingService";
import { FillerAnalysisError } from "../modules/gemini/fillerAnalysisService";
import type { CoachingFeedbackStore } from "../modules/persistence/coachingFeedbackRepository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function coachingRoutes(
  store: CoachingFeedbackStore | null,
): Router {
  const router = Router();
  router.post("/", json({ limit: "12mb" }), async (req, res) => {
    const input = validateCoachingInput(req.body);
    if (!input) {
      res.status(400).json({
        error:
          "Invalid coaching input or reference files. Use up to five PDFs or text files totaling 8 MB.",
      });
      return;
    }
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      res.status(503).json({
        error: "Gemini is not configured. Set GEMINI_API_KEY on the backend.",
      });
      return;
    }
    try {
      const result = await analyzeCoaching(input, key);
      const id = randomUUID();
      let persistenceError: string | undefined;
      if (store && UUID.test(input.session.id) && input.project.id) {
        try {
          await store.save(
            id,
            input.session.id,
            input.project.id,
            result.report,
            result.rawResponse,
          );
        } catch (error) {
          console.error("[tigerdata] could not save Gemini coaching:", error);
          persistenceError =
            "Tiger Data could not save this feedback; the browser will keep its copy.";
        }
      }
      res.json({ ...result, id, persistenceError });
    } catch (error) {
      const message =
        error instanceof FillerAnalysisError
          ? error.message
          : "Gemini coaching failed. Try again later.";
      const status =
        error instanceof FillerAnalysisError ? error.statusCode : 502;
      res.status(status).json({ error: message });
    }
  });

  return router;
}
