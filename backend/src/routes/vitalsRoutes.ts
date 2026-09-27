import { Router, raw, type Request } from "express";
import type { VitalSamplesStore } from "../modules/persistence/vitalSamplesRepository";
import {
  analyzeVideo,
  type VitalsResult,
} from "../modules/presage/vitalsService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saves the analysis to Tiger Data under the session the request names
 * (X-Session-Id, X-Session-Started-At). Failures are logged, not returned:
 * the analysis is still useful without them.
 */
async function saveSamples(
  vitalSamples: VitalSamplesStore,
  req: Request,
  result: VitalsResult,
): Promise<void> {
  const sessionId = req.header("x-session-id") ?? "";
  const startedAt = new Date(req.header("x-session-started-at") ?? "");
  if (!UUID.test(sessionId) || Number.isNaN(startedAt.getTime())) {
    console.warn(
      "[tigerdata] vitals not saved: the request needs X-Session-Id and X-Session-Started-At headers.",
    );
    return;
  }
  try {
    const rows = await vitalSamples.replaceSession(
      sessionId,
      startedAt,
      result,
    );
    console.log(
      `[tigerdata] saved ${rows} vital samples for session ${sessionId}`,
    );
  } catch (error) {
    console.error(
      `[tigerdata] could not save vital samples for session ${sessionId} (if the table is missing, run npm run db:migrate): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `vitalSamples` is null when Tiger Data isn't configured; analyses are then not saved. */
export default function createVitalsRoutes(
  vitalSamples: VitalSamplesStore | null,
): Router {
  const router = Router();

  router.post(
    "/",
    raw({ type: ["video/webm", "video/mp4"], limit: "50mb" }),
    async (req, res) => {
      // Vercel sets VERCEL=1. Presage's native SDK and FFmpeg can't run in its
      // functions, so say so instead of failing inside the analysis.
      if (process.env.VERCEL) {
        res.status(501).json({
          error:
            "Presage analysis runs only on the local backend (npm run dev), not on the Vercel deployment.",
        });
        return;
      }
      const mimeType =
        req.header("content-type")?.split(";")[0].toLowerCase() ?? "";
      if (mimeType !== "video/webm" && mimeType !== "video/mp4") {
        res.status(415).json({ error: "Send a WebM or MP4 recording." });
        return;
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        res.status(400).json({ error: "The recording is empty." });
        return;
      }
      const key = process.env.SMARTSPECTRA_API_KEY?.trim();
      if (!key) {
        res.status(503).json({
          error:
            "Presage is not configured. Set SMARTSPECTRA_API_KEY on the backend.",
        });
        return;
      }
      let result: VitalsResult;
      try {
        result = await analyzeVideo(req.body, mimeType, key);
      } catch (error) {
        console.error("Presage analysis failed:", error);
        res.status(502).json({
          error:
            "Presage could not analyze this recording. Try a longer run with face and chest visible.",
        });
        return;
      }
      if (vitalSamples) await saveSamples(vitalSamples, req, result);
      res.json(result);
    },
  );

  return router;
}
