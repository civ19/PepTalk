import { existsSync } from "node:fs";
import { join } from "node:path";

/** Loads the repo-root .env, if there is one. Variables already set in the environment win. */
export function loadRootEnv(): void {
  const file = join(__dirname, "..", "..", ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}
