import express from "express";
import type { VitalSamplesStore } from "./modules/persistence/vitalSamplesRepository";
import sessionRoutes from "./routes/sessionRoutes";
import transcriptionRoutes from "./routes/transcriptionRoutes";
import fillerAnalysisRoutes from "./routes/fillerAnalysisRoutes";
import createVitalsRoutes from "./routes/vitalsRoutes";
import interviewRoutes from "./routes/interviewRoutes"; // 👈 1. Added import

export interface AppOptions {
  /** Where Presage vitals are saved; null or left out when Tiger Data isn't configured. */
  vitalSamples?: VitalSamplesStore | null;
}

export default function createApp({ vitalSamples = null }: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  // 👈 2. Serve audio so browser can play ElevenLabs speech files
  app.use("/audio", express.static("interview_audio"));

  app.use("/api/sessions", sessionRoutes);
  app.use("/api/transcriptions", transcriptionRoutes);
  app.use("/api/filler-analysis", fillerAnalysisRoutes);
  app.use("/api/vitals", createVitalsRoutes(vitalSamples));
  
  // 👈 3. Mount Interview Mode routes
  app.use("/api/interview", interviewRoutes);

  return app;
}