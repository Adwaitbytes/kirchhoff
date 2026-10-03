import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Workflow code runs in CRE WASM (QuickJS) on every DON node: no Node built-ins, no clock, no randomness. */
const deterministicCore = {
  files: ["src/**/*.ts", "w*/main.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["node:*"], message: "core must run in CRE WASM: no Node built-ins" },
          { group: ["yaml", "ajv", "@kirchhoff/engine/spec"], message: "the spec compiler is build-time only (gen-config)" },
        ],
      },
    ],
    "no-restricted-properties": [
      "error",
      { object: "Date", property: "now", message: "use runtime.now(), the consensus clock" },
      { object: "Math", property: "random", message: "workflows are deterministic" },
    ],
    "no-restricted-globals": [
      "error",
      { name: "fetch", message: "use the CRE HTTP capability" },
      { name: "process", message: "config and secrets come from the CRE runtime" },
    ],
    "no-restricted-syntax": [
      "error",
      { selector: "NewExpression[callee.name='Date']", message: "use runtime.now(), the consensus clock" },
      { selector: "Literal[raw=/^\\d*\\.\\d/]", message: "no floats: amounts are bigint" },
      { selector: "CallExpression[callee.name='parseFloat']", message: "no floats: amounts are bigint" },
    ],
  },
};

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "**/binary.wasm", "**/.cre_build_tmp.*"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["src/cre-io.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
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
