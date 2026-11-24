// The twelve hat colours an inbox may wear, from design/tokens.json (`color.hat.<name>.fill`, light). A hat's
// key is its light fill, stored as `Inbox.color`. Any other colour is shown as the nearest hat, measured in
// OKLab like the design package does. A test checks these values against the token file.

export interface Hat {
  name: string;
  /** The light fill, `#rrggbb`: the value to store as `Inbox.color`. */
  fill: string;
}

export const HATS: readonly Hat[] = [
  { name: "red", fill: "#b53031" },
  { name: "orange", fill: "#a34a00" },
  { name: "amber", fill: "#875f02" },
  { name: "olive", fill: "#666e11" },
  { name: "green", fill: "#277a40" },
  { name: "teal", fill: "#077771" },
  { name: "sky", fill: "#027196" },
  { name: "blue", fill: "#285fcd" },
  { name: "violet", fill: "#714cbd" },
  { name: "plum", fill: "#914396" },
  { name: "pink", fill: "#a9356c" },
  { name: "slate", fill: "#5a697c" },
];

const HEX = /^#[0-9a-f]{6}$/i;

export const isHex = (text: string) => HEX.test(text);

/** A hat by its name, or null. */
export function hatNamed(name: string): Hat | null {
  return HATS.find((hat) => hat.name === name.trim().toLowerCase()) ?? null;
}

/** The hat a stored colour is shown as. Text that isn't a colour gets slate, as in the design package. */
export function nearestHat(color: string): Hat {
  if (!isHex(color)) return HATS.find((hat) => hat.name === "slate")!;
  const target = oklab(color);
  let best = HATS[0]!;
  let bestDistance = Infinity;
  for (const hat of HATS) {
    const [l, a, b] = oklab(hat.fill);
    const distance = (l - target[0]) ** 2 + (a - target[1]) ** 2 + (b - target[2]) ** 2;
    if (distance < bestDistance) {
      best = hat;
      bestDistance = distance;
    }
  }
  return best;
}

/** A coloured dot for a terminal that shows colour, or nothing. */
export function swatch(color: string, enabled: boolean): string {
  if (!enabled || !isHex(color)) return "";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m●\u001b[0m `;
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
