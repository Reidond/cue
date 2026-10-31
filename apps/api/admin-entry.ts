// The admin SPA's entry, at a root-absolute path so Vite rewrites it under the base (`/admin/`) on every deep link.
// `index.html` is the api project's, because the SPA is built as its client assets (apps/admin/vite.preset.ts).
import '../admin/src/main.tsx';
