// Builds every generated file in memory, then writes them or compares them with what is on disk.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildModel, readTokens } from "./tokens.mjs";
import { fontPlan, LICENCES } from "./fonts.mjs";
import { fontsCss, tokensCss } from "./css.mjs";
import { assetCatalog, loadIcons, packageLicence, packageVersion, readIconList, spriteSvg } from "./icons.mjs";
import { colorsSwift, hatsSwift, iconsSwift, metricsSwift, motionSwift, sampleSwift, typeSwift } from "./swift.mjs";
import { galleryContent, readSample } from "./sample.mjs";
import { galleryHtml } from "./gallery-html.mjs";
import { DESIGN, ICONS, OWNED, SAMPLE, SWIFT_SOURCES, TOKENS } from "./paths.mjs";

/** Every generated file as { "relative/path": string | Buffer }, relative to design/. */
export async function generate() {
  const model = buildModel(readTokens(TOKENS));
  const plan = fontPlan(model);
  const icons = await loadIcons(readIconList(ICONS));
  const version = packageVersion();
  const content = galleryContent(readSample(SAMPLE), model);
  const out = {};

  out["dist/web/tokens.css"] = tokensCss(model);
  out["dist/web/fonts.css"] = fontsCss(plan);
  for (const face of plan.web) out[`dist/web/fonts/${face.file}`] = readFileSync(face.from);
  for (const licence of LICENCES) out[`dist/web/fonts/${licence.name}`] = readFileSync(licence.from);
  out["dist/web/icons.svg"] = spriteSvg(icons, version);
  out["dist/web/icons-LICENSE.md"] = readFileSync(packageLicence());

  const swift = SWIFT_SOURCES;
  out[`${swift}/Generated/UsualColor.swift`] = colorsSwift(model);
  out[`${swift}/Generated/UsualHat+Palette.swift`] = hatsSwift(model);
  out[`${swift}/Generated/UsualType.swift`] = typeSwift(model, plan);
  out[`${swift}/Generated/UsualMetrics.swift`] = metricsSwift(model);
  out[`${swift}/Generated/UsualMotion+Tokens.swift`] = motionSwift(model);
  out[`${swift}/Generated/UsualIcon.swift`] = iconsSwift(icons, version);
  out[`${swift}/Generated/GallerySample.swift`] = sampleSwift(content);
  for (const face of plan.apple) out[`${swift}/Resources/Fonts/${face.file}`] = readFileSync(face.from);
  for (const licence of LICENCES) out[`${swift}/Resources/Fonts/${licence.name}`] = readFileSync(licence.from);
  for (const [path, file] of Object.entries(assetCatalog(icons))) out[`${swift}/Resources/Icons.xcassets/${path}`] = file;
  out[`${swift}/Resources/Hugeicons-LICENSE.md`] = readFileSync(packageLicence());

  out["gallery/index.html"] = galleryHtml(model, icons, content);
  return out;
}

const IGNORED = new Set([".DS_Store"]);

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));

/** Compares generated files with design/ on disk. Returns { missing, changed, extra } as relative paths. */
export function compare(out, root = DESIGN) {
  const missing = [];
  const changed = [];
  for (const [path, value] of Object.entries(out)) {
    const file = join(root, path);
    if (!existsSync(file)) missing.push(path);
    else if (!readFileSync(file).equals(bytes(value))) changed.push(path);
  }
  const extra = OWNED.flatMap((dir) => filesUnder(join(root, dir)))
    .map((file) => relative(root, file))
    .filter((path) => !(path in out));
  return { missing, changed, extra };
}

/** Writes what changed and removes stale files from the folders the generator owns. Returns the comparison. */
export function write(out, root = DESIGN) {
  const result = compare(out, root);
  for (const path of [...result.missing, ...result.changed]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes(out[path]));
  }
  for (const path of result.extra) rmSync(join(root, path));
  return result;
}
