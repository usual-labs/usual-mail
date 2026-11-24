// Reads tokens.json (Design Tokens Format Module 2025.10), checks the parts of the format this file uses, resolves
// references for light and dark, and returns a plain model the CSS and Swift writers share.
import { readFileSync } from "node:fs";

export const EXT = "dev.usual.mail";
const PROPS = new Set(["$value", "$type", "$description", "$extensions", "$deprecated"]);
const TYPES = new Set(["color", "dimension", "duration", "cubicBezier", "fontFamily", "fontWeight", "number", "typography", "shadow"]);
const WEIGHT_NAMES = {
  thin: 100, hairline: 100, "extra-light": 200, "ultra-light": 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, "semi-bold": 600, "demi-bold": 600, bold: 700, "extra-bold": 800, "ultra-bold": 800, black: 900, heavy: 900,
  "extra-black": 950, "ultra-black": 950,
};
export const APPLE_TEXT_STYLES = [
  "largeTitle", "title", "title2", "title3", "headline", "body", "callout", "subheadline", "footnote", "caption", "caption2",
];

const isRef = (v) => typeof v === "string" && /^\{[^{}]+\}$/.test(v);

/** Walks the tree and returns every token with its path and inherited type. */
function collect(tree, errors) {
  const tokens = new Map();
  const walk = (node, path, inherited) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`${path.join(".") || "(root)"}: a group or token must be an object`);
      return;
    }
    const type = node.$type ?? inherited;
    if (node.$type !== undefined && !TYPES.has(node.$type)) errors.push(`${path.join(".")}: unknown $type "${node.$type}"`);
    if (node.$description !== undefined && typeof node.$description !== "string") {
      errors.push(`${path.join(".")}: $description must be a string`);
    }
    for (const key of Object.keys(node)) {
      if (key.startsWith("$")) {
        if (!PROPS.has(key)) errors.push(`${[...path, key].join(".")}: unknown property`);
      } else if (/[{}.]/.test(key)) {
        errors.push(`${[...path, key].join(".")}: names may not contain {, } or .`);
      }
    }
    if ("$value" in node) {
      const children = Object.keys(node).filter((key) => !key.startsWith("$"));
      if (children.length) errors.push(`${path.join(".")}: a token can't also hold ${children.join(", ")}`);
      if (!type) errors.push(`${path.join(".")}: no $type on the token or a group above it`);
      tokens.set(path.join("."), { path, type, node });
      return;
    }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child, [...path, key], type);
  };
  walk(tree, [], undefined);
  return tokens;
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** Checks a literal (non-reference) value of `type`. Returns a list of problems. */
function checkLiteral(type, value, tokens, where) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(`${where}: ${message}`);
  const sub = (subType, subValue, name) => {
    if (isRef(subValue)) {
      const target = tokens.get(subValue.slice(1, -1));
      need(target, `${name} refers to ${subValue}, which doesn't exist`);
      if (target) need(target.type === subType, `${name} refers to a ${target.type} token, not ${subType}`);
    } else problems.push(...checkLiteral(subType, subValue, tokens, `${where}.${name}`));
  };
  switch (type) {
    case "color": {
      const ok = value && typeof value === "object";
      need(ok, "a colour is an object with colorSpace and components");
      if (!ok) break;
      need(value.colorSpace === "srgb", `colorSpace "${value.colorSpace}": this file uses "srgb" only`);
      const c = value.components;
      need(Array.isArray(c) && c.length === 3 && c.every((x) => num(x) && x >= 0 && x <= 1), "components are three numbers from 0 to 1");
      need(value.alpha === undefined || (num(value.alpha) && value.alpha >= 0 && value.alpha <= 1), "alpha is a number from 0 to 1");
      need(typeof value.hex === "string" && /^#[0-9a-f]{6}$/.test(value.hex), "hex is required here, as 6 lowercase digits (#rrggbb)");
      if (Array.isArray(c) && typeof value.hex === "string" && /^#[0-9a-f]{6}$/.test(value.hex)) {
        const bytes = [1, 3, 5].map((i) => parseInt(value.hex.slice(i, i + 2), 16));
        const fromComponents = c.map((x) => Math.round(x * 255));
        const exact = bytes.map((b) => Number((b / 255).toFixed(4)));
        need(
          fromComponents.every((b, i) => b === bytes[i]),
          `components ${JSON.stringify(c)} don't match hex ${value.hex}; for that hex use ${JSON.stringify(exact)}`,
        );
      }
      break;
    }
    case "dimension":
      need(value && num(value.value) && (value.unit === "px" || value.unit === "rem"), "a dimension is { value, unit: px | rem }");
      break;
    case "duration":
      need(value && num(value.value) && value.value >= 0 && (value.unit === "ms" || value.unit === "s"), "a duration is { value, unit: ms | s }");
      break;
    case "cubicBezier":
      need(
        Array.isArray(value) && value.length === 4 && value.every(num) && value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1,
        "a cubicBezier is [x1, y1, x2, y2] with x1 and x2 from 0 to 1",
      );
      break;
    case "fontFamily":
      need(typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string")), "a fontFamily is a string or an array of strings");
      break;
    case "fontWeight":
      need((num(value) && value >= 1 && value <= 1000) || value in WEIGHT_NAMES, "a fontWeight is 1 to 1000 or a named weight");
      break;
    case "number":
      need(num(value), "a number");
      break;
    case "typography": {
      const ok = value && typeof value === "object";
      need(ok, "typography is an object");
      if (!ok) break;
      const parts = { fontFamily: "fontFamily", fontSize: "dimension", fontWeight: "fontWeight", letterSpacing: "dimension", lineHeight: "number" };
      for (const [name, subType] of Object.entries(parts)) {
        if (need(name in value, `typography needs ${name}`) === true) sub(subType, value[name], name);
      }
      for (const name of Object.keys(value)) need(name in parts, `typography has no ${name}`);
      break;
    }
    case "shadow": {
      const layers = Array.isArray(value) ? value : [value];
      layers.forEach((layer, i) => {
        if (isRef(layer)) return sub("shadow", layer, `[${i}]`);
        const ok = layer && typeof layer === "object";
        need(ok, `layer ${i} is an object`);
        if (!ok) return;
        sub("color", layer.color, `[${i}].color`);
        for (const name of ["offsetX", "offsetY", "blur", "spread"]) sub("dimension", layer[name], `[${i}].${name}`);
        need(layer.inset === undefined || typeof layer.inset === "boolean", `layer ${i}: inset is true or false`);
      });
      break;
    }
  }
  return problems;
}

function checkValue(type, value, tokens, where) {
  if (!isRef(value)) return checkLiteral(type, value, tokens, where);
  const target = tokens.get(value.slice(1, -1));
  if (!target) return [`${where}: refers to ${value}, which doesn't exist`];
  if (target.type !== type) return [`${where}: refers to a ${target.type} token, not ${type}`];
  return [];
}

/** Checks tokens.json. Returns { tokens, errors }. */
export function validate(tree) {
  const errors = [];
  const tokens = collect(tree, errors);
  for (const [key, { type, node }] of tokens) {
    errors.push(...checkValue(type, node.$value, tokens, key));
    const ext = node.$extensions?.[EXT];
    if (node.$extensions !== undefined && (typeof node.$extensions !== "object" || node.$extensions === null)) {
      errors.push(`${key}: $extensions must be an object`);
    }
    if (ext === undefined) {
      if (type === "color" && !isRef(node.$value)) errors.push(`${key}: a colour needs a dark value in $extensions["${EXT}"].dark`);
      continue;
    }
    for (const name of Object.keys(ext)) {
      if (!["dark", "reducedMotion", "appleTextStyle", "iphone"].includes(name)) errors.push(`${key}: unknown extension "${name}"`);
    }
    if ("dark" in ext) errors.push(...checkValue(type, ext.dark, tokens, `${key} (dark)`));
    else if (type === "color" && !isRef(node.$value)) errors.push(`${key}: a colour needs a dark value`);
    if ("reducedMotion" in ext) {
      if (type !== "duration") errors.push(`${key}: reducedMotion belongs on durations`);
      else errors.push(...checkValue("duration", ext.reducedMotion, tokens, `${key} (reducedMotion)`));
    }
    if ("appleTextStyle" in ext) {
      if (type !== "typography") errors.push(`${key}: appleTextStyle belongs on typography`);
      else if (ext.appleTextStyle !== null && !APPLE_TEXT_STYLES.includes(ext.appleTextStyle)) {
        errors.push(`${key}: appleTextStyle "${ext.appleTextStyle}" is not one of ${APPLE_TEXT_STYLES.join(", ")} or null`);
      }
    }
    if ("iphone" in ext) {
      if (type !== "typography") errors.push(`${key}: iphone belongs on typography`);
      else errors.push(...checkValue("dimension", ext.iphone?.fontSize, tokens, `${key} (iphone.fontSize)`));
    }
  }
  // References must not loop.
  for (const key of tokens.keys()) {
    const seen = new Set();
    let value = tokens.get(key).node.$value;
    while (isRef(value)) {
      const target = value.slice(1, -1);
      if (seen.has(target)) {
        errors.push(`${key}: its references loop`);
        break;
      }
      seen.add(target);
      value = tokens.get(target)?.node.$value;
    }
  }
  return { tokens, errors };
}

/** Resolves a value, following references, in `mode` ("light" or "dark"). Sub-values of composites are resolved too. */
function resolver(tokens) {
  const resolve = (value, mode) => {
    if (isRef(value)) {
      const target = tokens.get(value.slice(1, -1));
      const ext = target.node.$extensions?.[EXT];
      return resolve(mode === "dark" && ext && "dark" in ext ? ext.dark : target.node.$value, mode);
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, mode));
    if (value && typeof value === "object" && !("colorSpace" in value) && !("unit" in value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, mode)]));
    }
    return value;
  };
  return (key, mode = "light") => {
    const { node } = tokens.get(key);
    const ext = node.$extensions?.[EXT];
    return resolve(mode === "dark" && ext && "dark" in ext ? ext.dark : node.$value, mode);
  };
}

const px = (dimension) => (dimension.unit === "rem" ? dimension.value * 16 : dimension.value);
const ms = (duration) => (duration.unit === "s" ? duration.value * 1000 : duration.value);
const weight = (value) => (typeof value === "number" ? value : WEIGHT_NAMES[value]);
const color = (value) => ({ hex: value.hex, alpha: value.alpha ?? 1 });
const shadows = (value) =>
  (Array.isArray(value) ? value : [value]).map((layer) => ({
    color: color(layer.color),
    x: px(layer.offsetX),
    y: px(layer.offsetY),
    blur: px(layer.blur),
    spread: px(layer.spread),
    inset: layer.inset === true,
  }));

/** Builds the model every writer uses from a checked token tree. */
export function buildModel(tree) {
  const { tokens, errors } = validate(tree);
  if (errors.length) throw new Error(`tokens.json has problems:\n- ${errors.join("\n- ")}`);
  const get = resolver(tokens);
  const keys = [...tokens.keys()];
  const under = (prefix) => keys.filter((key) => key.startsWith(prefix + "."));
  const leaf = (key) => key.split(".").at(-1);
  const describe = (key) => tokens.get(key).node.$description;
  const ext = (key) => tokens.get(key).node.$extensions?.[EXT] ?? {};

  const colors = under("color")
    .filter((key) => !key.startsWith("color.hat."))
    .map((key) => ({ name: leaf(key), description: describe(key), light: color(get(key)), dark: color(get(key, "dark")) }));

  const hatNames = [...new Set(under("color.hat").map((key) => key.split(".")[2]))];
  const hats = hatNames.map((name) => {
    const role = (part) => ({ light: color(get(`color.hat.${name}.${part}`)), dark: color(get(`color.hat.${name}.${part}`, "dark")) });
    return { name, fill: role("fill"), on: role("on"), tint: role("tint") };
  });

  const families = Object.fromEntries(
    under("font.family").map((key) => {
      const value = get(key);
      return [leaf(key), { stack: Array.isArray(value) ? value : [value], description: describe(key) }];
    }),
  );
  const familyName = (stack) => Object.keys(families).find((name) => families[name].stack.join() === stack.join());

  const type = under("type").map((key) => {
    const value = get(key);
    const size = px(value.fontSize);
    const extension = ext(key);
    return {
      name: leaf(key),
      description: describe(key),
      family: familyName(Array.isArray(value.fontFamily) ? value.fontFamily : [value.fontFamily]),
      size,
      weight: weight(value.fontWeight),
      tracking: Number((px(value.letterSpacing) / size).toFixed(4)),
      lineHeight: value.lineHeight,
      appleTextStyle: extension.appleTextStyle ?? null,
      iphoneSize: extension.iphone ? px(extension.iphone.fontSize) : size,
    };
  });

  const dimensions = (group) => under(group).map((key) => ({ name: leaf(key), description: describe(key), px: px(get(key)) }));

  return {
    colors,
    hats,
    families,
    weights: Object.fromEntries(under("font.weight").map((key) => [leaf(key), weight(get(key))])),
    type,
    space: dimensions("space"),
    radius: dimensions("radius"),
    size: dimensions("size"),
    elevation: under("elevation").map((key) => ({
      name: leaf(key),
      description: describe(key),
      light: shadows(get(key)),
      dark: shadows(get(key, "dark")),
    })),
    durations: under("motion.duration").map((key) => ({
      name: leaf(key),
      description: describe(key),
      ms: ms(get(key)),
      reducedMs: ext(key).reducedMotion ? ms(ext(key).reducedMotion) : ms(get(key)),
    })),
    easings: under("motion.easing").map((key) => ({ name: leaf(key), description: describe(key), points: get(key) })),
  };
}

export function readTokens(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
