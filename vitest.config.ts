import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "frontend/test/**/*.test.ts",
      "backend/test/transcriptionRoutes.test.ts",
      "backend/test/fillerAnalysisRoutes.test.ts",
      "backend/test/vitalsRoutes.test.ts",
      "backend/test/vitalSamplesRepository.test.ts",
      "backend/test/videoFrames.test.ts",
      "backend/test/vitalsService.test.ts",
      "backend/test/vercelEntry.test.ts",
      "backend/test/expressions.test.ts",
    ],
    exclude: ["**/node_modules/**", "PrepTalk/**"],
  },
});
