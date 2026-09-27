import express from "express";
import type { VitalSamplesStore } from "./modules/persistence/vitalSamplesRepository";
import sessionRoutes from "./routes/sessionRoutes";
import transcriptionRoutes from "./routes/transcriptionRoutes";
import fillerAnalysisRoutes from "./routes/fillerAnalysisRoutes";
import createVitalsRoutes from "./routes/vitalsRoutes";
import coachingRoutes from "./routes/coachingRoutes";
import type { CoachingFeedbackStore } from "./modules/persistence/coachingFeedbackRepository";

export interface AppOptions {
  /** Where Presage vitals are saved; null or left out when Tiger Data isn't configured. */
  vitalSamples?: VitalSamplesStore | null;
  coachingFeedback?: CoachingFeedbackStore | null;
}

export default function createApp({
  vitalSamples = null,
  coachingFeedback = null,
}: AppOptions = {}) {
  const app = express();
  // Coaching can include base64 PDF references; its route has a separate limit.
  app.use("/api/coaching", coachingRoutes(coachingFeedback));
  app.use(express.json());
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/transcriptions", transcriptionRoutes);
  app.use("/api/filler-analysis", fillerAnalysisRoutes);
  app.use("/api/vitals", createVitalsRoutes(vitalSamples));
  return app;
}
