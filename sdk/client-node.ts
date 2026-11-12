import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalStorage } from "./client/types.js";
/** Local CLI/sandbox storage. Crash-left locks require operator reconciliation; never steal a signing lock. */
export function fileJournalStorage(filename: string): JournalStorage {
  const path = resolve(filename),
    dir = dirname(path),
    lock = `${path}.lock`;
  return {
    read: async () => {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 3_000_000)
          throw new Error("Invalid journal file");
        return await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    write: async (envelope) => {
      const temporary = resolve(dir, `.${basename(path)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(envelope, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
        const directory = await open(dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
    exclusive: async (action) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            "Journal is locked; reconcile any interrupted signing before removing its lock",
          );
        throw e;
      }
      try {
        return await action();
      } finally {
        await rm(lock, { recursive: true });
      }
    },
  };
}
