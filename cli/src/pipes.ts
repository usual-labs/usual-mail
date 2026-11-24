// Output cut short: when whoever reads the command's output stops reading (`usual-mail … | head`), the next write
// fails with EPIPE. Without a handler Node prints the error with a stack trace; a command line tool exits quietly.

/** The codes a write gives once the reader has gone. */
const GONE = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * Exits quietly, with 0, as soon as a write to one of these streams finds its reader gone, as a program does whose
 * reader stopped listening. Any other error on the streams is thrown as before.
 */
export function exitQuietlyOnClosedPipe(streams: NodeJS.WritableStream[], exit: (code: number) => void): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (!GONE.has(error.code ?? "")) throw error;
      exit(0);
    });
  }
}
