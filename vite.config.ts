import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Stamps the built shell into the emitted `sw.js`: one `self.__VERSION` (the cache
 * name) and one `self.__PRECACHE` list. Follows the build's real outDir (`--outDir`
 * included) and strips any earlier stamp first, so a reused outDir never doubles it.
 * ponytail: a dozen lines instead of vite-plugin-pwa; the worker itself is hand-written.
 */
export function swPrecache(): Plugin {
  let outDir = '';
  return {
    name: 'tautan-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const sw = join(outDir, 'sw.js');
      if (!existsSync(sw)) return;
      const assets = existsSync(join(outDir, 'assets')) ? readdirSync(join(outDir, 'assets')) : [];
      const files = ['/index.html', '/manifest.webmanifest', ...assets.map((f) => `/assets/${f}`)];
      // Asset names carry Vite's content hash, so hashing the names tracks the contents.
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 8);
      const header = `self.__VERSION=${JSON.stringify(version)};self.__PRECACHE=${JSON.stringify(files)};\n`;
      const body = readFileSync(sw, 'utf8').replace(/^self\.__VERSION=[^\n]*\n/, '');
      writeFileSync(sw, header + body);
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), swPrecache()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  // ES2022 matches tsconfig; main.tsx's top-level await (the mock chunk gate) needs it.
  build: { target: 'es2022', outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: ['.ts.net', 'localhost'], // tailscale serve forwards with the tailnet Host header
    proxy: { '/api': { target: 'http://127.0.0.1:7700', changeOrigin: false } },
  },
});
