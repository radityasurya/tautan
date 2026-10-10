import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swPrecache } from '../vite.config';

/** The two hooks the test drives; everything else on the plugin is Vite's business. */
type Stamp = { configResolved(c: { root: string; build: { outDir: string } }): void; closeBundle(): void };

function stamp(root: string, outDir: string): void {
  const plugin = swPrecache() as unknown as Stamp;
  plugin.configResolved({ root, build: { outDir } });
  plugin.closeBundle();
}

describe('swPrecache plugin', () => {
  test('stamps version and asset list into the outDir sw.js', () => {
    const out = mkdtempSync(join(tmpdir(), 'swpre-'));
    writeFileSync(join(out, 'sw.js'), '// worker\n');
    mkdirSync(join(out, 'assets'));
    writeFileSync(join(out, 'assets', 'app-abc123.js'), '');
    stamp(out, '.');
    expect(readFileSync(join(out, 'sw.js'), 'utf8')).toMatch(
      /^self\.__VERSION="[0-9a-f]{8}";self\.__PRECACHE=\["\/index\.html","\/manifest\.webmanifest","\/assets\/app-abc123\.js"\];\n\/\/ worker\n$/,
    );
  });

  test('does not double the stamp when the outDir is reused', () => {
    const out = mkdtempSync(join(tmpdir(), 'swpre-'));
    writeFileSync(join(out, 'sw.js'), '// worker\n');
    stamp(out, '.');
    const once = readFileSync(join(out, 'sw.js'), 'utf8');
    stamp(out, '.'); // Vite empties no outDir outside the project root
    expect(readFileSync(join(out, 'sw.js'), 'utf8')).toBe(once);
  });

  test('excludes the mock chunk and sorts the asset list', () => {
    const out = mkdtempSync(join(tmpdir(), 'swpre-'));
    writeFileSync(join(out, 'sw.js'), '// worker\n');
    mkdirSync(join(out, 'assets'));
    writeFileSync(join(out, 'assets', 'mock-43f1de.js'), ''); // fixture chunk, gated behind ?mock
    writeFileSync(join(out, 'assets', 'index-B0.js'), '');
    writeFileSync(join(out, 'assets', 'index-A.js'), '');
    stamp(out, '.');
    expect(readFileSync(join(out, 'sw.js'), 'utf8')).toMatch(
      /^self\.__VERSION="[0-9a-f]{8}";self\.__PRECACHE=\["\/index\.html","\/manifest\.webmanifest","\/assets\/index-A\.js","\/assets\/index-B0\.js"\];\n\/\/ worker\n$/,
    );
  });

  test('never precaches a lazy-* chunk: the editor and CodeMirror load on the first Edit tap', () => {
    const out = mkdtempSync(join(tmpdir(), 'swpre-'));
    writeFileSync(join(out, 'sw.js'), '// worker\n');
    mkdirSync(join(out, 'assets'));
    for (const name of ['index-A.js', 'lazy-editor-B.js', 'lazy-index-C.js']) writeFileSync(join(out, 'assets', name), '');
    stamp(out, '.');
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).toContain('"/assets/index-A.js"');
    expect(sw).not.toContain('lazy-');
  });

  test('stamps the configured outDir only', () => {
    const root = mkdtempSync(join(tmpdir(), 'swpre-'));
    for (const dir of ['a', 'b']) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, 'sw.js'), `// ${dir}\n`);
    }
    stamp(root, 'b');
    expect(readFileSync(join(root, 'a', 'sw.js'), 'utf8')).toBe('// a\n');
    expect(readFileSync(join(root, 'b', 'sw.js'), 'utf8')).toMatch(/^self\.__VERSION=/);
  });
});
