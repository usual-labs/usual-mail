// Generates the web styles, the Swift values, the fonts, the icons and the HTML gallery from tokens.json and icons.json.
//   node scripts/build.mjs           write what changed and remove stale files
//   node scripts/build.mjs --check   fail if anything on disk differs from what would be generated
import { compare, generate, write } from "./lib/outputs.mjs";

const check = process.argv.includes("--check");

try {
  const out = await generate();
  const result = check ? compare(out) : write(out);
  const lines = [
    ...result.missing.map((path) => `${check ? "missing" : "wrote  "} ${path}`),
    ...result.changed.map((path) => `${check ? "changed" : "updated"} ${path}`),
    ...result.extra.map((path) => `${check ? "stale  " : "removed"} ${path}`),
  ];
  const total = Object.keys(out).length;
  if (check && lines.length) {
    console.error(`Generated files are out of date. Run \`npm run build\` in design/.\n  ${lines.join("\n  ")}`);
    process.exit(1);
  }
  if (lines.length) console.log(lines.join("\n"));
  console.log(check ? `All ${total} generated files are current.` : `${total} generated files, ${lines.length} written or removed.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
