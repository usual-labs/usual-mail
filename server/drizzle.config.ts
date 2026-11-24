import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes the next migration into migrations/ after src/db/schema.ts changes.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
