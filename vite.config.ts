import { defineConfig } from 'vite-plus';

// The one lint and format configuration for every TypeScript file in the repository
// (`vp check` reads only this file); package-specific rules go in `overrides`.
export default defineConfig({
    lint: {
        plugins: ['typescript'],
        options: {
            typeAware: true,
            typeCheck: true,
        },
        ignorePatterns: ['**/node_modules/**', 'apps/mac/**'],
    },
    fmt: {
        singleQuote: true,
        tabWidth: 4,
        printWidth: 140,
        // TypeScript only: Markdown, YAML and JSON are written by hand and read as they are.
        ignorePatterns: ['**/node_modules/**', 'apps/mac/**', '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml'],
    },
});
