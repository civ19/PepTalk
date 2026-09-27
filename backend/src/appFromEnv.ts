// The app wired from the environment (and the repo's .env when there is one).
// Shared by the local server (index.ts) and the Vercel function (api/index.ts),
// so both save Presage vitals to Tiger Data when DATABASE_URL is set.

import createApp from "./app";
import { loadRootEnv } from "./env";
import { createPool, databaseUrlFromEnv } from "./modules/persistence/database";
import { VitalSamplesRepository } from "./modules/persistence/vitalSamplesRepository";
import { CoachingFeedbackRepository } from "./modules/persistence/coachingFeedbackRepository";
import { AccountRepository } from "./modules/persistence/accountRepository";

export function appFromEnv() {
  loadRootEnv();
  const databaseUrl = databaseUrlFromEnv();
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  const vitalSamples = pool ? new VitalSamplesRepository(pool) : null;
  const coachingFeedback = pool ? new CoachingFeedbackRepository(pool) : null;
  const accounts = pool ? new AccountRepository(pool) : null;
  return {
    app: createApp({ vitalSamples, coachingFeedback, accounts }),
    vitalSamples,
  };
}
