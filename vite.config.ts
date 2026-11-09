import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-server only: lets the running game save a canvas screenshot into ./previews
 * (used for QA captures). Bound to 127.0.0.1 like the rest of the dev server.
 */
const previewShots = (): Plugin => ({
  name: 'breakpoint-preview-shots',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__shot', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? 'shot';
      const name = raw.replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'shot';
      const chunks: Uint8Array[] = [];
      let size = 0;
      req.on('data', (chunk: Uint8Array) => {
        size += chunk.length;
        if (size > 30_000_000) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        const dir = resolve(server.config.root, 'previews');
        mkdirSync(dir, { recursive: true });
        const file = resolve(dir, `${name}.png`);
        writeFileSync(file, Buffer.concat(chunks));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ file, bytes: size }));
      });
    });
  },
});

// All caches and build output stay inside the project folder (on the external RAID volume).
export default defineConfig({
  plugins: [previewShots()],
  cacheDir: '.cache/vite',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: true, watch: { ignored: ['**/.cache/**', '**/logs/**', '**/dist/**', '**/previews/**'] } },
  build: { target: 'es2022', outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
  optimizeDeps: { include: ['three', '@dimforge/rapier3d-compat'] },
});
