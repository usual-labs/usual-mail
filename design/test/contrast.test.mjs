// Computed WCAG 2 contrast for the colours people read. AA asks 4.5:1 for text and 3:1 for the parts of a control
// that identify it, such as a focus ring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast } from "../scripts/lib/color.mjs";
import { buildModel, readTokens } from "../scripts/lib/tokens.mjs";
import { TOKENS } from "../scripts/lib/paths.mjs";

const model = buildModel(readTokens(TOKENS));
const color = (name) => model.colors.find((c) => c.name === name);
const MODES = ["light", "dark"];
const TEXT = 4.5;
const UI = 3;

function expectContrast(fgName, fg, bgName, bg, minimum) {
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= minimum, `${fgName} ${fg} on ${bgName} ${bg}: ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
}

for (const mode of MODES) {
  test(`body and meta text meet AA on every ground (${mode})`, () => {
    for (const text of ["ink", "body", "meta"]) {
      for (const ground of ["background", "surface", "sunken", "hover", "selected"]) {
        expectContrast(text, color(text)[mode].hex, ground, color(ground)[mode].hex, TEXT);
      }
    }
  });

  test(`status colours meet AA on grounds and on their tints (${mode})`, () => {
    for (const status of ["danger", "success", "attention"]) {
      const tint = color(`${status}-tint`)[mode].hex;
      for (const ground of ["background", "surface"]) expectContrast(status, color(status)[mode].hex, ground, color(ground)[mode].hex, TEXT);
      expectContrast(status, color(status)[mode].hex, `${status}-tint`, tint, TEXT);
      for (const text of ["ink", "body", "meta"]) expectContrast(text, color(text)[mode].hex, `${status}-tint`, tint, TEXT);
    }
  });

  test(`on-ink reads on ink, and the focus ring stands out (${mode})`, () => {
    expectContrast("on-ink", color("on-ink")[mode].hex, "ink", color("ink")[mode].hex, TEXT);
    for (const ground of ["background", "surface"]) expectContrast("focus", color("focus")[mode].hex, ground, color(ground)[mode].hex, UI);
  });

  test(`each hat's on-colour reads on its fill, and its tint holds text (${mode})`, () => {
    assert.ok(model.hats.length >= 10 && model.hats.length <= 14, `about twelve hats, not ${model.hats.length}`);
    for (const hat of model.hats) {
      const [fill, on, tint] = [hat.fill[mode].hex, hat.on[mode].hex, hat.tint[mode].hex];
      expectContrast(`${hat.name}.on`, on, `${hat.name}.fill`, fill, TEXT);
      expectContrast(`${hat.name}.fill`, fill, `${hat.name}.tint`, tint, TEXT);
      for (const text of ["ink", "body", "meta"]) expectContrast(text, color(text)[mode].hex, `${hat.name}.tint`, tint, TEXT);
      for (const ground of ["background", "surface"]) expectContrast(`${hat.name}.fill`, fill, ground, color(ground)[mode].hex, UI);
    }
  });
}

test("the contrast maths matches known WCAG values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
  assert.equal(contrast("#ffffff", "#ffffff"), 1);
});
