// Where the generator reads from and writes to. Every path is relative to design/.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DESIGN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TOKENS = join(DESIGN, "tokens.json");
export const ICONS = join(DESIGN, "icons.json");
export const SAMPLE = join(DESIGN, "..", "core", "fixtures", "sample.json");
export const PACKAGES = join(DESIGN, "node_modules");
/** Prociono Regular and its licence, copied from usual.dev/public/fonts (the family's own copy). */
export const PROCIONO = join(DESIGN, "fonts");

/** The Swift package's source folder, relative to design/. */
export const SWIFT_SOURCES = "swift/Sources/UsualMailDesign";

/**
 * Folders the generator owns completely: a file in them that the generator didn't write is stale. Hand-written Swift
 * lives beside Generated/ and Resources/, never inside them.
 */
export const OWNED = ["dist", `${SWIFT_SOURCES}/Generated`, `${SWIFT_SOURCES}/Resources`, "gallery"];
