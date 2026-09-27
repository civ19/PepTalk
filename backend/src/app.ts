import express from "express";
import type { VitalSamplesStore } from "./modules/persistence/vitalSamplesRepository";
import sessionRoutes from "./routes/sessionRoutes";
import transcriptionRoutes from "./routes/transcriptionRoutes";
import fillerAnalysisRoutes from "./routes/fillerAnalysisRoutes";
import createVitalsRoutes from "./routes/vitalsRoutes";

export interface AppOptions {
  /** Where Presage vitals are saved; null or left out when Tiger Data isn't configured. */
  vitalSamples?: VitalSamplesStore | null;
}

export default function createApp({ vitalSamples = null }: AppOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/transcriptions", transcriptionRoutes);
  app.use("/api/filler-analysis", fillerAnalysisRoutes);
  app.use("/api/vitals", createVitalsRoutes(vitalSamples));
  return app;
}
