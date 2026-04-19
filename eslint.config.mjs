import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "state/*.json", "package-lock.json"]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parserOptions: {
        project: "./tsconfig.typecheck.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Promise の握り忘れは通知漏れや state 更新漏れに直結するため、型情報つきで検出する。
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "no-console": "error"
    }
  },
  {
    files: ["src/logger.ts"],
    rules: {
      // ログ出力は secret マスクを通すため logger.ts に集約し、それ以外の console 直書きを防ぐ。
      "no-console": "off"
    }
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
);
