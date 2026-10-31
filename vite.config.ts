import { defineConfig } from 'vite-plus';

// The one lint and format configuration for every TypeScript file in the repository
// (`vp check` reads only this file); package-specific rules go in `overrides`.
export default defineConfig({
    lint: {
        // react (which carries the react-hooks rules) and jsx-a11y are for the admin SPA's JSX; nothing else here has any.
        plugins: ['typescript', 'react', 'jsx-a11y'],
        options: {
            typeAware: true,
            typeCheck: true,
        },
        ignorePatterns: ['**/node_modules/**', 'apps/mac/**', 'apps/admin/src/routeTree.gen.ts'],
        rules: {
            'react/rules-of-hooks': 'error',
            'react/exhaustive-deps': 'error',
            // Flags every table cell as a control that needs a label.
            'jsx-a11y/control-has-associated-label': 'off',
        },
    },
    fmt: {
        singleQuote: true,
        tabWidth: 4,
        printWidth: 140,
        // TypeScript only: Markdown, YAML and JSON are written by hand and read as they are.
        ignorePatterns: [
            '**/node_modules/**',
            'apps/mac/**',
            'apps/admin/src/routeTree.gen.ts',
            '**/*.md',
            '**/*.json',
            '**/*.yaml',
            '**/*.yml',
        ],
    },
});
