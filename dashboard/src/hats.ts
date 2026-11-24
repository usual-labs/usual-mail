// A company's hat: the twelve hat colours from the design system, and the nearest one to a stored Inbox.color.
// The same maths as design/scripts/lib/sample.mjs (matchHat) and color.mjs (OKLab), which design doesn't export.
import { HAT_KEYS } from "./generated/assets.ts";

export interface Hat {
  /** The palette name, used as `data-hat`. */
  name: string;
  /** The hat's light fill, "#rrggbb": what is stored as Inbox.color when a person picks it. */
  key: string;
  /** For people: "Blue". */
  label: string;
}

export const HATS: readonly Hat[] = HAT_KEYS.map(({ name, key }) => ({
  name,
  key,
  label: name.charAt(0).toUpperCase() + name.slice(1),
}));

const HEX = /^#[0-9a-f]{6}$/;
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363371923 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: string, b: string): number {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const SLATE = HATS.find((hat) => hat.name === "slate") ?? HATS[0]!;

/** The hat whose light fill is nearest the stored colour in OKLab. A key matches itself; text that isn't a colour is slate. */
export function hatFor(stored: string): Hat {
  const hex = String(stored).toLowerCase();
  if (!HEX.test(hex)) return SLATE;
  return HATS.reduce((best, hat) => (distance(hex, hat.key) < distance(hex, best.key) ? hat : best));
}

/** The hat with this key, or undefined when the colour is not one of the twelve. */
export function hatByKey(key: string): Hat | undefined {
  const hex = key.toLowerCase();
  return HATS.find((hat) => hat.key === hex);
}
