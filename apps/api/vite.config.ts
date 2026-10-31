import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// `server.port` is the only way to choose `cf dev`'s port (`cf dev --port` is rejected); the e2e harness gives every case
// its own backend, with its own port and its own persisted state.
export default defineConfig({
    server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5173), strictPort: true },
    plugins: [cloudflare({ persistState: { path: process.env.CUE_STATE_DIR ?? '.cloudflare/state' } })],
});
