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
      // Sorted, so the version hash is stable across rebuilds; readdirSync order is not.
      const assets = (existsSync(join(outDir, 'assets')) ? readdirSync(join(outDir, 'assets')) : []).sort();
      // `mock-<hash>.js` is fetched only behind the ?mock gate, and `lazy-*` (the editor and
      // CodeMirror) only on the first Edit tap: neither is precached for everyone.
      const files = [
        '/index.html',
        '/manifest.webmanifest',
        ...assets.filter((f) => !f.startsWith('mock-') && !f.startsWith('lazy-')).map((f) => `/assets/${f}`),
      ];
      // Asset names carry Vite's content hash, so hashing the names tracks the contents.
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 8);
      const header = `self.__VERSION=${JSON.stringify(version)};self.__PRECACHE=${JSON.stringify(files)};\n`;
      const body = readFileSync(sw, 'utf8').replace(/^self\.__VERSION=[^\n]*\n/, '');
      writeFileSync(sw, header + body);
    },
  };
}

/** A module that loads only when Edit is tapped: the editor itself, and CodeMirror under it. */
const LAZY = /[\\/]node_modules[\\/](?:@codemirror|@lezer|@marijn|crelt|style-mod|w3c-keyname)[\\/]|[\\/]web[\\/]editor\.tsx$/;

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), swPrecache()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  // ES2022 matches tsconfig; main.tsx's top-level await (the mock chunk gate) needs it.
  build: {
    target: 'es2022',
    outDir: '../dist/web',
    emptyOutDir: true,
    // Any chunk holding the editor or CodeMirror is `lazy-*`, which swPrecache leaves out, so
    // the shell and an app update stay the size they were before the editor existed.
    rollupOptions: {
      output: { chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => LAZY.test(id)) ? 'assets/lazy-[name]-[hash].js' : 'assets/[name]-[hash].js') },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: ['.ts.net', 'localhost'], // tailscale serve forwards with the tailnet Host header
    proxy: { '/api': { target: 'http://127.0.0.1:7700', changeOrigin: false } },
  },
});
