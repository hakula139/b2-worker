import base from '@hakula139/eslint-config';
import typescript from '@hakula139/eslint-config/typescript';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  base,
  typescript,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['.claude/', '.wrangler/', 'node_modules/'],
  },
]);
