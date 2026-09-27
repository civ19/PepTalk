import { Router, raw } from "express";
import { analyzeVideo } from "../modules/presage/vitalsService";

const router = Router();

router.post(
  "/",
  raw({ type: ["video/webm", "video/mp4"], limit: "50mb" }),
  async (req, res) => {
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
    try {
      res.json(await analyzeVideo(req.body, mimeType, key));
    } catch (error) {
      console.error("Presage analysis failed:", error);
      res.status(502).json({
        error:
          "Presage could not analyze this recording. Try a longer run with face and chest visible.",
      });
    }
  },
);

export default router;
