import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "api/**"] },
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
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
