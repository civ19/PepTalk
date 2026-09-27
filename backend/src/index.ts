import createApp from "./app";
import { loadRootEnv } from "./env";
import { createPool, databaseUrlFromEnv } from "./modules/persistence/database";
import { TigerDataRepository } from "./modules/persistence/tigerDataRepository";
import { readDeviceId, resolveMediaRoot } from "./modules/storage/mediaRoot";
import { LocalMediaStore } from "./modules/storage/mediaStore";
import { RecordingService } from "./modules/storage/recordingService";

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = databaseUrlFromEnv();
  let recordings: RecordingService | null = null;
  if (databaseUrl) {
    const mediaRoot = resolveMediaRoot();
    recordings = new RecordingService(
      new TigerDataRepository(createPool(databaseUrl)),
      new LocalMediaStore(mediaRoot),
      await readDeviceId(mediaRoot),
    );
    console.log(`[storage] recordings are stored in ${mediaRoot}`);
  } else {
    console.warn(
      "[storage] DATABASE_URL is not set, so recordings can't be saved (see .env.example).",
    );
  }

  createApp(recordings).listen(4000, () => console.log("Backend on 4000"));

  // Catch up with files deleted or moved while the server was off.
  recordings?.reconcile().then(
    ({ missing, restored }) => {
      if (missing || restored) {
        console.log(
          `[storage] reconciled media: ${missing} missing, ${restored} restored`,
        );
      }
    },
    (err: unknown) =>
      console.error(
        `[storage] could not check media against Tiger Data (if the tables are missing, run npm run db:migrate): ${err instanceof Error ? err.message : String(err)}`,
      ),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
