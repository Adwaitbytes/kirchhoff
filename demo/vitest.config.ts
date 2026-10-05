import { defineConfig } from "vitest/config";

// Unit tests never read the repo .env (no secrets, same result locally and in a clean CI clone).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], env: { KIRCHHOFF_DOTENV: "none" } } });
