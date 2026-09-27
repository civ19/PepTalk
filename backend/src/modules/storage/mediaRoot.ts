// The media folder: where this machine keeps recordings. It's a per-user
// app-data folder, never inside the repo, and the same in dev and production.
// PREPTALK_MEDIA_DIR overrides it.
//
//   Windows  %LOCALAPPDATA%\PrepTalk\media
//   macOS    ~/Library/Application Support/PrepTalk/media
//   Linux    $XDG_DATA_HOME/PrepTalk/media (default ~/.local/share)
//
// OneDrive and iCloud don't sync these folders, and on macOS they aren't
// behind the Documents/Desktop permission prompt.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { isUuid } from "./objectKeys";

export function resolveMediaRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.PREPTALK_MEDIA_DIR?.trim();
  if (override) return resolve(override);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return win32.join(local, "PrepTalk", "media");
  }
  if (platform === "darwin") {
    return posix.join(
      home,
      "Library",
      "Application Support",
      "PrepTalk",
      "media",
    );
  }
  const data = env.XDG_DATA_HOME || posix.join(home, ".local", "share");
  return posix.join(data, "PrepTalk", "media");
}

/**
 * Id of this media folder, stored as media_objects.device_id. Created on
 * first use in the folder's device.json, so it follows the files if the
 * folder moves to another machine.
 */
export async function readDeviceId(root: string): Promise<string> {
  const file = join(root, "device.json");
  await mkdir(root, { recursive: true });
  try {
    const text = `${JSON.stringify({ id: randomUUID() }, null, 2)}\n`;
    await writeFile(file, text, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const { id } = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
  if (typeof id !== "string" || !isUuid(id)) {
    throw new Error(`${file} does not hold a valid device id`);
  }
  return id;
}
