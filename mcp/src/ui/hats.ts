/**
 * An inbox's stored colour shown as the nearest of the twelve hats, by distance in OKLab between light fills,
 * the same maths as design/scripts/lib (matchHat) and the Swift package. Text that isn't a colour gets slate.
 */
import { HAT_FILLS } from "./design.generated.ts";

type Lab = readonly [number, number, number];

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function oklab(hex: string): Lab {
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

const HATS = HAT_FILLS.map(([name, fill]) => ({ name, lab: oklab(fill) }));

export function hatFor(color: string): string {
  const hex = color.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return "slate";
  const lab = oklab(hex);
  let best = HATS[0]!;
  let bestDistance = Infinity;
  for (const hat of HATS) {
    const distance = Math.hypot(hat.lab[0] - lab[0], hat.lab[1] - lab[1], hat.lab[2] - lab[2]);
    if (distance < bestDistance) [best, bestDistance] = [hat, distance];
  }
  return best.name;
}
