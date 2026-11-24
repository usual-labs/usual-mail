// The server in a Docker container. The data directory on this machine is mounted at /data, the container runs
// as this machine's user so the files stay the person's own, and the port is published on 127.0.0.1 only.

import { createHash } from "node:crypto";
import { CONTAINER_PORT, DEFAULT_CONTAINER, DEFAULT_IMAGE, type RunSettings } from "../config.ts";
import { note, type Context } from "../context.ts";
import { Failure } from "../errors.ts";
import type { RunResult } from "../runner.ts";
import { findCheckout, KILLED_WORDS, STOP_SECONDS, waitForStop, type Launcher, type RunState } from "./launcher.ts";

/** A label on the container holding a hash of its settings, so `init` knows when to make it again. */
export const SETTINGS_LABEL = "dev.usual.mail.settings";
const PROBE_MS = 10_000;
/** A container's exit code when its process was killed: 128 + SIGKILL's 9. */
const KILLED_EXIT = 137;

export function dockerLauncher(ctx: Context, run: RunSettings): Launcher {
  const docker = ctx.env.USUAL_MAIL_DOCKER || "docker";
  const image = run.image ?? DEFAULT_IMAGE;
  const name = run.container ?? DEFAULT_CONTAINER;
  const user = ctx.userIds();
  // The address the browser reaches the server at, for Google sign-in: the port is published on 127.0.0.1 only, and
  // inside the container the server listens on every address, so it can't know it. In the hash, so a container made
  // before this is made again (its data stays). So is the time it gets to stop (`--stop-timeout`).
  const publicUrl = `http://127.0.0.1:${run.port}`;
  const settings = createHash("sha256")
    .update(JSON.stringify({ image, port: run.port, dataDir: run.dataDir, user, publicUrl, stopSeconds: STOP_SECONDS }))
    .digest("hex")
    .slice(0, 16);

  const call = (args: string[], timeoutMs = PROBE_MS) => ctx.runner.run(docker, args, { timeoutMs });

  async function answers(): Promise<string | null> {
    const result = await call(["version", "--format", "{{.Server.Version}}"]);
    if (result.missing) return "Docker isn't installed on this machine. Install it, or run the server with Node (`usual-mail init --mode node`).";
    if (result.code !== 0) {
      return "Docker isn't answering. Start Docker Desktop or the Docker service, wait until it says it is running, and try again.";
    }
    return null;
  }

  async function inspect(): Promise<{ state: RunState; settings?: string; detail?: string }> {
    const format = `{{.State.Status}}|{{index .Config.Labels "${SETTINGS_LABEL}"}}`;
    const result = await call(["container", "inspect", "--format", format, name]);
    if (result.code !== 0) {
      if (/no such (container|object)/i.test(result.stderr)) return { state: "missing" };
      return { state: "unknown", detail: (await answers()) ?? failed("docker container inspect", result) };
    }
    const [status = "", given = ""] = result.stdout.trim().split("|");
    const label = given === "<no value>" ? "" : given;
    if (status === "running" || status === "restarting") {
      return { state: "running", settings: label, detail: status === "restarting" ? "restarting after it stopped" : undefined };
    }
    return { state: "stopped", settings: label };
  }

  async function create(): Promise<void> {
    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--restart",
      "unless-stopped",
      // As the Compose files give it: a plain `docker stop`, and Docker's own at shutdown, wait as long.
      "--stop-timeout",
      String(STOP_SECONDS),
      "--publish",
      `127.0.0.1:${run.port}:${CONTAINER_PORT}`,
      "--volume",
      `${run.dataDir}:/data`,
      "--env",
      `USUAL_MAIL_PUBLIC_URL=${publicUrl}`,
      "--label",
      `${SETTINGS_LABEL}=${settings}`,
      ...(user ? ["--user", `${user.uid}:${user.gid}`] : []),
      image,
    ];
    const result = await call(args, 120_000);
    if (result.code !== 0) throw new Failure(failed("docker run", result));
  }

  /**
   * Stops the running container, giving the server as long as the Compose files do to store the mail in hand, and
   * says when Docker had to kill it. `-t`, not `--time` (deprecated in Docker 29, which warns) nor `--timeout` (too
   * new for older Docker).
   */
  async function stopRunning(): Promise<void> {
    let result: RunResult | undefined;
    const stopping = call(["stop", "-t", String(STOP_SECONDS), name], (STOP_SECONDS + 60) * 1000).then((r) => (result = r));
    const inTime = await waitForStop(ctx, () => result !== undefined);
    const stopped = await stopping;
    if (stopped.code !== 0) throw new Failure(failed("docker stop", stopped));
    // `docker stop` succeeds whether the server stopped by itself or Docker killed it at its deadline, so the
    // container says which. Its exit code alone isn't enough: a container stopped while it restarts keeps the code of
    // whatever ended it last, such as an out-of-memory kill (137 too). Killed by this stop only when the stop ran past
    // `waitForStop`'s deadline (Docker's comes after it, counted from its SIGTERM) and the container ended with
    // SIGKILL's code without Docker's out-of-memory flag.
    if (inTime) return;
    const exit = await call(["container", "inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", name]);
    if (exit.code === 0 && exit.stdout.trim() === `${KILLED_EXIT} false`) note(ctx, KILLED_WORDS);
  }

  return {
    label: "Docker",

    async prepare({ build = true } = {}) {
      const problem = await answers();
      if (problem) throw new Failure(problem, "failed");
      const found = await call(["image", "inspect", "--format", "{{.Id}}", image]);
      if (found.code === 0) return;
      const source = findCheckout(ctx);
      if (!build || !source) {
        throw new Failure(
          `The image "${image}" isn't on this machine. Build it from a checkout of Usual Mail ` +
            `(\`docker build -t ${image} <checkout>\`), or name another with --image.`,
        );
      }
      note(ctx, `Building the image "${image}" from ${source}. The first build takes a few minutes.`);
      const code = await ctx.runner.pass(docker, ["build", "--tag", image, source], { progress: true });
      if (code !== 0) throw new Failure(`Building the image failed (docker build exited with ${code}). Its output is above.`);
    },

    async state() {
      const { state, detail } = await inspect();
      return detail ? { state, detail } : { state };
    },

    async start() {
      const now = await inspect();
      if (now.state === "unknown") throw new Failure(now.detail ?? "Docker isn't answering.");
      if (now.state !== "missing" && !now.settings) {
        throw new Failure(
          `A container named "${name}" exists that usual-mail didn't make. Remove it, or pick another name with --container.`,
        );
      }
      if (now.state !== "missing" && now.settings !== settings) {
        // Made by an earlier `init` with other settings (or by hand): make it again. The data stays on disk. Stopped
        // first, since `rm --force` kills a running server at once.
        if (now.state === "running") await stopRunning();
        const removed = await call(["rm", "--force", name], 60_000);
        if (removed.code !== 0) throw new Failure(failed("docker rm", removed));
        await create();
        return true;
      }
      if (now.state === "running") return false;
      if (now.state === "missing") {
        await create();
        return true;
      }
      const started = await call(["start", name], 60_000);
      if (started.code !== 0) throw new Failure(failed("docker start", started));
      return true;
    },

    async stop() {
      const now = await inspect();
      if (now.state === "unknown") throw new Failure(now.detail ?? "Docker isn't answering.");
      if (now.state !== "running") return false;
      await stopRunning();
      return true;
    },

    async logs({ follow, lines }) {
      const code = await ctx.runner.pass(docker, ["logs", ...(follow ? ["--follow"] : []), "--tail", String(lines), name]);
      if (code !== 0) throw new Failure(`docker logs exited with ${code}. \`usual-mail status\` says whether the container exists.`);
    },

    async tail(lines) {
      const result = await call(["logs", "--tail", String(lines), name]);
      return `${result.stdout}${result.stderr}`;
    },

    async exposure() {
      const result = await call(["port", name, `${CONTAINER_PORT}/tcp`]);
      return result.code === 0 ? (result.stdout.trim().split("\n")[0] ?? null) : null;
    },
  };
}

function failed(what: string, result: RunResult): string {
  if (result.timedOut) return `${what} took too long. Docker may be stuck; restart it and try again.`;
  const said = (result.stderr || result.stdout).trim();
  return `${what} failed${said ? `: ${said}` : ""}.`;
}
