// Which font files ship where. Geist comes from Vercel's `geist` npm package (SIL OFL 1.1); Prociono from design/fonts,
// copied from usual.dev. The web gets WOFF2 (Prociono stays TTF, as on usual.dev); the apps get TTF where the package has
// it. Geist Serif is WOFF2 only in the package, and Core Text registers WOFF2 directly.
import { join } from "node:path";
import { PACKAGES, PROCIONO } from "./paths.mjs";

const GEIST = join(PACKAGES, "geist", "dist", "fonts");
const GEIST_STATIC = { 100: "Thin", 200: "UltraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "Black", 900: "UltraBlack" };

export const LICENCES = [
  { from: join(PACKAGES, "geist", "LICENSE.txt"), name: "Geist-OFL.txt" },
  { from: join(PROCIONO, "Prociono-OFL.txt"), name: "Prociono-OFL.txt" },
];

/** Families with one weight. Asking them for another weight is a mistake the model checks for. */
export const SINGLE_WEIGHT = { serif: 400, wordmark: 400 };

/**
 * The plan for the fonts the tokens name. `weights` are the weights tokens.json defines; Geist Sans ships each of
 * them as a static file in the apps. The mono family is the system's and ships nothing.
 */
export function fontPlan(model) {
  const sansWeights = [...new Set(Object.values(model.weights))].sort((a, b) => a - b);
  for (const weight of sansWeights) {
    if (!GEIST_STATIC[weight]) throw new Error(`Geist Sans has no static file for weight ${weight}`);
  }
  for (const role of model.type) {
    const only = SINGLE_WEIGHT[role.family];
    if (only !== undefined && role.weight !== only) {
      throw new Error(`type.${role.name}: the ${role.family} family has only weight ${only}, not ${role.weight}`);
    }
  }
  const family = (name) => model.families[name].stack[0];
  return {
    web: [
      { family: family("serif"), weight: "400", file: "GeistSerif-Regular.woff2", format: "woff2", from: join(GEIST, "geist-serif", "GeistSerif-Regular.woff2"), display: "swap" },
      { family: family("sans"), weight: "100 900", file: "Geist-Variable.woff2", format: "woff2", from: join(GEIST, "geist-sans", "Geist-Variable.woff2"), display: "swap" },
      // Prociono blocks briefly rather than swapping, as on usual.dev: a wordmark in a fallback serif reads as a different name.
      { family: family("wordmark"), weight: "400", file: "Prociono-Regular.ttf", format: "truetype", from: join(PROCIONO, "Prociono-Regular.ttf"), display: "block" },
    ],
    apple: [
      { family: "serif", weight: 400, file: "GeistSerif-Regular.woff2", postScript: "GeistSerif-Regular", from: join(GEIST, "geist-serif", "GeistSerif-Regular.woff2") },
      ...sansWeights.map((weight) => ({
        family: "sans",
        weight,
        file: `Geist-${GEIST_STATIC[weight]}.ttf`,
        postScript: `Geist-${GEIST_STATIC[weight]}`,
        from: join(GEIST, "geist-sans", `Geist-${GEIST_STATIC[weight]}.ttf`),
      })),
      { family: "wordmark", weight: 400, file: "Prociono-Regular.ttf", postScript: "Prociono-Regular", from: join(PROCIONO, "Prociono-Regular.ttf") },
    ],
  };
}
