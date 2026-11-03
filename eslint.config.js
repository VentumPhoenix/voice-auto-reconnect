// Lint config for this repository's own tooling (logic, tests, configs).
// The plugin files are additionally linted with Vencord's own ESLint config in CI.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["node_modules", "coverage", "vencord"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        rules: {
            "quotes": ["error", "double", { avoidEscape: true }],
            "semi": ["error", "always"],
            "eqeqeq": ["error", "always", { null: "ignore" }],
            "prefer-const": "error",
            "no-trailing-spaces": "error",
            "eol-last": ["error", "always"],
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
);
