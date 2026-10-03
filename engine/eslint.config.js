import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** The rules core must obey to compile for CRE WASM and stay deterministic across DON nodes. */
const deterministicCore = {
  files: ["src/**/*.ts"],
  ignores: ["src/spec/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["node:*"], message: "core must run in CRE WASM: no Node built-ins" },
          { group: ["yaml", "ajv"], message: "spec parsing deps belong to @kirchhoff/engine/spec only" },
        ],
      },
    ],
    "no-restricted-properties": [
      "error",
      { object: "Date", property: "now", message: "pass timestamps in; the engine never reads a clock" },
      { object: "Math", property: "random", message: "the engine is deterministic" },
    ],
    "no-restricted-globals": [
      "error",
      { name: "fetch", message: "no network inside the engine" },
      { name: "process", message: "no environment access inside the engine" },
    ],
    "no-restricted-syntax": [
      "error",
      { selector: "NewExpression[callee.name='Date']", message: "the engine never reads a clock" },
      { selector: "Literal[raw=/^\\d*\\.\\d/]", message: "no floats: amounts are bigint" },
      { selector: "CallExpression[callee.name='parseFloat']", message: "no floats: amounts are bigint" },
    ],
  },
};

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  deterministicCore,
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
