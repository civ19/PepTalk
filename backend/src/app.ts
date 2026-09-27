import express from "express";
import sessionRoutes from "./routes/sessionRoutes";
import transcriptionRoutes from "./routes/transcriptionRoutes";
import fillerAnalysisRoutes from "./routes/fillerAnalysisRoutes";
import vitalsRoutes from "./routes/vitalsRoutes";

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionRoutes);
app.use("/api/transcriptions", transcriptionRoutes);
app.use("/api/filler-analysis", fillerAnalysisRoutes);
app.use("/api/vitals", vitalsRoutes);
export default app;
