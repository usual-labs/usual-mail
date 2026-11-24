// Picks how to run the server that `init` set up.

import type { RunSettings } from "../config.ts";
import type { Context } from "../context.ts";
import { dockerLauncher } from "./docker.ts";
import type { Launcher } from "./launcher.ts";
import { nodeLauncher } from "./node.ts";

export function launcherFor(ctx: Context, run: RunSettings): Launcher {
  return run.mode === "docker" ? dockerLauncher(ctx, run) : nodeLauncher(ctx, run);
}
