// Checks that the browser agent's prompt core serves (`googleSetupPrompt`, src/google-setup.ts) is word for word the
// code block in docs/google-setup-agent.md, with the redirect line's blank put back. Fails when either changes alone.
import { readFileSync } from "node:fs";
import { GOOGLE_PROMPT_REDIRECT_BLANK, googleSetupPrompt } from "../src/google-setup.ts";

const doc = readFileSync(new URL("../../docs/google-setup-agent.md", import.meta.url), "utf8");
// Fenced blocks that start at the line's beginning: the guide's example lines and the prompt.
const blocks = [...doc.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map((match) => match[1]);
const expected = googleSetupPrompt(GOOGLE_PROMPT_REDIRECT_BLANK);
const block = blocks.find((text) => text.startsWith(expected.split("\n")[0]));

if (!block) {
  console.error("docs/google-setup-agent.md has no code block that starts like core's prompt (googleSetupPrompt).");
  process.exit(1);
}
if (block !== expected) {
  const shown = block.split("\n");
  const want = expected.split("\n");
  const at = want.findIndex((line, i) => line !== shown[i]);
  const line = at === -1 ? Math.min(shown.length, want.length) : at;
  console.error(
    "The prompt in docs/google-setup-agent.md and core's googleSetupPrompt differ. Change them together.\n" +
      `First difference at the prompt's line ${line + 1}:\n  core: ${want[line] ?? "(nothing)"}\n  doc:  ${shown[line] ?? "(nothing)"}`,
  );
  process.exit(1);
}
console.log("The browser agent's prompt in core matches docs/google-setup-agent.md.");
