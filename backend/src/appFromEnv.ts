// The app wired from the environment (and the repo's .env when there is one).
// Shared by the local server (index.ts) and the Vercel function (api/index.ts),
// so both save Presage vitals to Tiger Data when DATABASE_URL is set.

import createApp from "./app";
import { loadRootEnv } from "./env";
import { createPool, databaseUrlFromEnv } from "./modules/persistence/database";
import { VitalSamplesRepository } from "./modules/persistence/vitalSamplesRepository";

export function appFromEnv() {
  loadRootEnv();
  const databaseUrl = databaseUrlFromEnv();
  const vitalSamples = databaseUrl
    ? new VitalSamplesRepository(createPool(databaseUrl))
    : null;
  return { app: createApp({ vitalSamples }), vitalSamples };
}
