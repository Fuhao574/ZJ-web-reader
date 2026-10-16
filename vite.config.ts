import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { generateCatalog } from './scripts/build-catalog.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

export default defineConfig({
  base: './',
  server: { fs: { deny: ['.env', '.env.*', '**/*.{crt,pem}', '**/.git/**', '**/reader-private/**', '**/server/**'] } },
  plugins: [{
    name: 'cloud-bookshelf',
    async buildStart() { await generateCatalog(publicDir); },
    configureServer(server) {
      // Regenerate the catalog when local source books are added / replaced / removed.
      let queue = Promise.resolve();
      server.watcher.on('all', (event, file) => {
        if (!['add', 'change', 'unlink'].includes(event) || !file.startsWith(publicDir + '/books/')) return;
        queue = queue.then(async () => {
          await generateCatalog(publicDir);
          server.ws.send({ type: 'full-reload' });
        }).catch(error => { server.config.logger.error(String(error)); });
      });
    },
  }],
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
