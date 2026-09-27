import createApp from "./app";
import { loadRootEnv } from "./env";
import { createPool, databaseUrlFromEnv } from "./modules/persistence/database";
import { VitalSamplesRepository } from "./modules/persistence/vitalSamplesRepository";

loadRootEnv();

const databaseUrl = databaseUrlFromEnv();
const vitalSamples = databaseUrl
  ? new VitalSamplesRepository(createPool(databaseUrl))
  : null;

if (vitalSamples) {
  // Say at startup, not at the first save, when Tiger Data can't take samples.
  vitalSamples.check().then(
    () =>
      console.log(
        "[tigerdata] Presage vitals are saved to presage_vital_samples",
      ),
    (err: unknown) =>
      console.error(
        `[tigerdata] Presage vitals can't be saved (if the table is missing, run npm run db:migrate): ${err instanceof Error ? err.message : String(err)}`,
      ),
  );
} else {
  console.warn(
    "[tigerdata] DATABASE_URL is not set, so Presage vitals aren't saved (see .env.example).",
  );
}

createApp({ vitalSamples }).listen(4000, "0.0.0.0", () =>
  console.log("Backend on 4000"),
);
