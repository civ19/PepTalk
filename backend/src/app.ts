import express from "express";
import type { RecordingService } from "./modules/storage/recordingService";
import createSessionRoutes from "./routes/sessionRoutes";

/** `recordings` is null when Tiger Data isn't configured; the session routes then answer 503. */
export default function createApp(recordings: RecordingService | null) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", createSessionRoutes(recordings));
  return app;
}
