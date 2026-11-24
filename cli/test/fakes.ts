// Fakes for Docker and for running the server with Node. Both start the stand-in as "the server", keyed by data
// directory so its state survives a restart like the real store does.

import { appendFileSync } from "node:fs";
import type { Runner, RunResult } from "../src/runner.ts";
import { StandIn } from "./stand-in.ts";

const servers = new Map<string, StandIn>();

/** The stand-in that serves a data directory, made on first use. */
export function serverFor(dataDir: string, ownerFormat: "text" | "json" = "text"): StandIn {
  let server = servers.get(dataDir);
  if (!server) servers.set(dataDir, (server = new StandIn({ dataDir, ownerFormat })));
  return server;
}

export async function closeAll(): Promise<void> {
  await Promise.all([...servers.values()].map((server) => server.close()));
  servers.clear();
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

interface Container {
  state: "running" | "exited";
  label: string;
  port: number;
  dataDir: string;
  args: string[];
}

export class FakeDocker implements Runner {
  readonly calls: string[][] = [];
  readonly images = new Set<string>();
  readonly containers = new Map<string, Container>();
  /** False makes `docker version` time out, as a stuck Docker Desktop does. */
  answering = true;
  /** Output of `docker logs`. */
  log = "Usual Mail server on http://0.0.0.0:8484\n";

  async run(command: string, args: string[]): Promise<RunResult> {
    this.calls.push([command, ...args]);
    if (!this.answering) return { code: -1, stdout: "", stderr: "", timedOut: true };
    const [verb, ...rest] = args;
    switch (verb) {
      case "version":
        return ok("27.3.1\n");
      case "image":
        return this.images.has(rest.at(-1)!) ? ok("sha256:abc\n") : no(`Error: No such image: ${rest.at(-1)}`);
      case "container": {
        const container = this.containers.get(rest.at(-1)!);
        if (!container) return no(`Error: No such container: ${rest.at(-1)}`);
        return ok(`${container.state}|${container.label}\n`);
      }
      case "run":
        return this.#run(rest);
      case "start": {
        const container = this.containers.get(rest[0]!);
        if (!container) return no(`Error: No such container: ${rest[0]}`);
        await serverFor(container.dataDir).listen(container.port);
        container.state = "running";
        return ok(`${rest[0]}\n`);
      }
      case "stop": {
        const container = this.containers.get(rest[0]!);
        if (!container) return no(`Error: No such container: ${rest[0]}`);
        await serverFor(container.dataDir).close();
        container.state = "exited";
        return ok(`${rest[0]}\n`);
      }
      case "rm": {
        const name = rest.at(-1)!;
        const container = this.containers.get(name);
        if (container) await serverFor(container.dataDir).close();
        this.containers.delete(name);
        return ok(`${name}\n`);
      }
      case "logs":
        return ok(this.log);
      case "port": {
        const container = this.containers.get(rest[0]!);
        return container ? ok(`127.0.0.1:${container.port}\n`) : no("Error: No such container");
      }
      default:
        return no(`fake docker doesn't know ${verb}`);
    }
  }

  async pass(command: string, args: string[]): Promise<number> {
    this.calls.push([command, ...args]);
    if (args[0] === "build") {
      this.images.add(args[args.indexOf("--tag") + 1]!);
      return 0;
    }
    if (args[0] === "logs") return 0;
    return 1;
  }

  async startDetached(): Promise<number> {
    throw new Error("Docker mode doesn't start processes");
  }
  isAlive(): boolean {
    return false;
  }
  signal(): void {}

  async #run(args: string[]): Promise<RunResult> {
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const name = value("--name");
    if (this.containers.has(name)) return no(`Conflict. The container name "/${name}" is already in use`, 125);
    const image = args.at(-1)!;
    if (!this.images.has(image)) return no(`Unable to find image '${image}:latest' locally`, 125);
    const port = Number(value("--publish").split(":")[1]);
    const dataDir = value("--volume").replace(/:\/data$/, "");
    const label = value("--label").split("=")[1]!;
    await serverFor(dataDir).listen(port);
    this.containers.set(name, { state: "running", label, port, dataDir, args });
    return ok("0123456789abcdef\n");
  }

  /** The verbs called, for example ["version", "image", "container", "run"]. */
  verbs(): string[] {
    return this.calls.map((call) => call[1]!);
  }
}

export class FakeNode implements Runner {
  readonly started: string[][] = [];
  readonly signals: Array<[number, string]> = [];
  #pids = new Map<number, string>();
  #next = 40_000;

  async run(command: string, args: string[]): Promise<RunResult> {
    throw new Error(`Node mode runs no other programs: ${command} ${args.join(" ")}`);
  }
  async pass(command: string): Promise<number> {
    throw new Error(`Node mode runs no other programs: ${command}`);
  }

  async startDetached(command: string, args: string[], options: { cwd: string; logFile: string }): Promise<number> {
    this.started.push([command, ...args]);
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const dataDir = value("--data-dir");
    const server = serverFor(dataDir);
    await server.listen(Number(value("--port")));
    appendFileSync(options.logFile, `Usual Mail server on ${server.url} (data in ${dataDir})\n`, { mode: 0o600 });
    const pid = this.#next++;
    this.#pids.set(pid, dataDir);
    return pid;
  }

  isAlive(pid: number): boolean {
    const dataDir = this.#pids.get(pid);
    return Boolean(dataDir && servers.get(dataDir)?.listening);
  }

  signal(pid: number, signal: string): void {
    this.signals.push([pid, signal]);
    const dataDir = this.#pids.get(pid);
    if (dataDir) void servers.get(dataDir)?.close();
  }
}
