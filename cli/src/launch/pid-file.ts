// Node mode's pid file: which process is the server and, while a command stops it, which command. Commands can run at
// the same time (a `stop` in one terminal, a `start` finishing that stop in another), so a command changes the file
// only while it still names the server that command acted on, so as not to remove or overwrite the record of a server
// another command has started since. POSIX has no compare-and-swap for files, so each change checks the file and acts
// straight after, and a removal takes the file aside with an atomic rename before it decides. A record written in the
// moment between a check and its action can still be lost (docs/agents/known-issues.md, "Node mode's pid file").

import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { STOPPING } from "./launcher.ts";

/**
 * The server's process id on the first line. Once a command has sent it SIGTERM, a second line, `stopping <pid>`,
 * names that command's process. `usual-mail` 0.1.0 wrote the first line only, which still reads as a running server.
 */
export interface Recorded {
  pid: number;
  /** Set while a command stops the server: that command's process id, or 0 when the file doesn't say. */
  stoppedBy?: number;
}

export function readRecord(file: string): Recorded | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const [first = "", second = ""] = text.split("\n");
  const pid = Number(first.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [mark, by] = second.trim().split(/\s+/);
  if (mark !== STOPPING) return { pid };
  const stoppedBy = Number(by);
  return { pid, stoppedBy: Number.isInteger(stoppedBy) && stoppedBy > 0 ? stoppedBy : 0 };
}

const format = (record: Recorded) =>
  record.stoppedBy === undefined ? `${record.pid}\n` : `${record.pid}\n${STOPPING} ${record.stoppedBy}\n`;

/** A name beside the file that only this process uses. */
const own = (file: string, what: string) => `${file}.${process.pid}.${what}`;

/** Written whole under this process's own name, owner-only, to be renamed or linked into place. */
function prepared(file: string, record: Recorded): string {
  const temp = own(file, "tmp");
  writeFileSync(temp, format(record), { mode: 0o600 });
  return temp;
}

/** Records a server this command has just started. Renamed into place, so a reader never sees half a file. */
export function writeRecord(file: string, record: Recorded): void {
  renameSync(prepared(file, record), file);
}

/** Replaces the record with `next` if it still names `pid`. True when it did. */
export function replaceRecord(file: string, pid: number, next: Recorded): boolean {
  const temp = prepared(file, next);
  if (readRecord(file)?.pid !== pid) {
    rmSync(temp, { force: true });
    return false;
  }
  renameSync(temp, file);
  return true;
}

/**
 * Removes the record if it still names `pid`. True when it did. The file is moved aside under this process's own name
 * first: the rename is atomic, so what was moved is one whole version that no other command can change, and it is
 * deleted only if it names `pid`. Otherwise it goes back, unless another command has written a newer one meanwhile:
 * as a hard link, which fails if one is there, or, on a filesystem without hard links, by a rename once no file is
 * there (a record written between that check and the rename is replaced).
 */
export function removeRecord(file: string, pid: number): boolean {
  if (readRecord(file)?.pid !== pid) return false;
  const taken = own(file, "taken");
  try {
    renameSync(file, taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    if (readRecord(taken)?.pid === pid) return true;
    try {
      linkSync(taken, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(file)) renameSync(taken, file);
    }
    return false;
  } finally {
    rmSync(taken, { force: true });
  }
}
