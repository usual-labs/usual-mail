// tokens.json follows the parts of the Design Tokens format it uses, and the checker catches the usual mistakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildModel, readTokens, validate } from "../scripts/lib/tokens.mjs";
import { fontPlan, LICENCES } from "../scripts/lib/fonts.mjs";
import { matchHat, readSample } from "../scripts/lib/sample.mjs";
import { DESIGN, SAMPLE, SWIFT_SOURCES, TOKENS } from "../scripts/lib/paths.mjs";

const tree = readTokens(TOKENS);
const model = buildModel(tree);
const copy = () => structuredClone(tree);

test("tokens.json has no problems", () => {
  assert.deepEqual(validate(tree).errors, []);
});

test("the checker catches a hex that disagrees with its components", () => {
  const t = copy();
  t.color.ink.$value.hex = "#0a0b0e";
  assert.match(validate(t).errors.join("\n"), /color\.ink: components .* don't match hex #0a0b0e; for that hex use/);
});

test("the checker catches a colour with no dark value", () => {
  const t = copy();
  delete t.color.ink.$extensions;
  assert.match(validate(t).errors.join("\n"), /color\.ink: a colour needs a dark value/);
});

test("the checker catches broken references, bad names, units and types", () => {
  const t = copy();
  t.type.body.$value.fontFamily = "{font.family.nope}";
  t.space["1.5"] = { $value: { value: 1.5, unit: "px" } };
  t.radius.sm.$value.unit = "pt";
  t.color.$type = "colour";
  const errors = validate(t).errors.join("\n");
  assert.match(errors, /fontFamily refers to \{font\.family\.nope\}, which doesn't exist/);
  assert.match(errors, /space\.1\.5: names may not contain/);
  assert.match(errors, /radius\.sm: a dimension is/);
  assert.match(errors, /unknown \$type "colour"/);
});

test("the checker catches a reference loop", () => {
  const t = copy();
  t.color.focus.$value = "{color.focus}";
  assert.match(validate(t).errors.join("\n"), /color\.focus: its references loop/);
});

test("the model has the colours, hats, roles and scales the brief asks for", () => {
  const colors = model.colors.map((c) => c.name);
  for (const name of ["background", "surface", "sunken", "ink", "body", "meta", "line", "hover", "on-ink", "danger", "success", "focus"]) {
    assert.ok(colors.includes(name), `no color.${name}`);
  }
  for (const hat of model.hats) for (const part of ["fill", "on", "tint"]) assert.ok(hat[part].light.hex && hat[part].dark.hex);
  assert.deepEqual(model.type.map((t) => t.name), ["display", "title", "heading", "reading", "body", "label", "caption", "mono", "wordmark"]);
  for (const role of ["display", "title", "heading", "reading"]) assert.equal(model.type.find((t) => t.name === role).family, "serif");
  for (const role of ["body", "label", "caption"]) assert.equal(model.type.find((t) => t.name === role).family, "sans");
  assert.equal(model.type.find((t) => t.name === "wordmark").family, "wordmark");
  assert.ok(model.space.length >= 8 && model.radius.length >= 4 && model.durations.length >= 3 && model.easings.length >= 2);
  assert.ok(model.durations.some((d) => d.reducedMs === 0) && model.durations.some((d) => d.reducedMs > 0));
});

test("one-weight families are never asked for another weight", () => {
  for (const role of model.type.filter((t) => t.family === "serif" || t.family === "wordmark")) assert.equal(role.weight, 400, role.name);
  const broken = buildModel(tree);
  broken.type.find((t) => t.name === "heading").weight = 600;
  assert.throws(() => fontPlan(broken), /serif family has only weight 400/);
});

test("every font file and licence the plan names exists", () => {
  const plan = fontPlan(model);
  for (const face of [...plan.web, ...plan.apple, ...LICENCES]) assert.ok(existsSync(face.from), face.from);
  for (const face of plan.apple) assert.ok(existsSync(join(DESIGN, SWIFT_SOURCES, "Resources", "Fonts", face.file)), face.file);
  for (const face of plan.web) assert.ok(existsSync(join(DESIGN, "dist", "web", "fonts", face.file)), face.file);
  assert.match(readFileSync(join(DESIGN, "dist/web/fonts/Geist-OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(readFileSync(join(DESIGN, "dist/web/fonts/Prociono-OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("a stored inbox colour lands on the nearest hat, and a key on itself", () => {
  for (const hat of model.hats) assert.equal(matchHat(model.hats, hat.fill.light.hex).name, hat.name);
  const picks = Object.fromEntries(readSample(SAMPLE).inboxes.map((inbox) => [inbox.color, matchHat(model.hats, inbox.color).name]));
  assert.deepEqual(picks, { "#2F6FED": "blue", "#1F8A5B": "green", "#C2541D": "orange" });
  assert.equal(matchHat(model.hats, "not a colour").name, "slate");
});

test("dependency versions are exact", () => {
  const pkg = JSON.parse(readFileSync(join(DESIGN, "package.json"), "utf8"));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} ${version} is not exact`);
  }
});
