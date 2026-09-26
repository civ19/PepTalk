import { rename, rm, writeFile } from 'node:fs/promises';

/** Writes pretty JSON via a temp file and rename, so readers never see a half-written file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, file);
  } catch {
    // Windows can refuse to replace a file another process has open (e.g. a virus scanner).
    await writeFile(file, text, 'utf8');
    await rm(tmp, { force: true });
  }
}
