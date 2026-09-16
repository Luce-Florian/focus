// Compiles every entry point with esbuild: three application bundles (main,
// preload, renderer) plus one bundle per test file, each inlining its own
// copy of the src modules it imports (see the issue: no module in src/main
// holds mutable module-level state, so that duplication is safe). tsc never
// emits; this script is the only thing that turns .ts into runnable .js.
import { build } from 'esbuild';
import { cpSync, globSync, mkdirSync } from 'node:fs';

const OUT = 'dist';

async function main() {
  mkdirSync(`${OUT}/renderer`, { recursive: true });

  await Promise.all([
    build({
      entryPoints: ['src/main/index.ts'],
      outfile: `${OUT}/main.js`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: ['electron'],
      sourcemap: true
    }),
    build({
      entryPoints: ['src/preload.ts'],
      outfile: `${OUT}/preload.cjs`,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      sourcemap: true
    }),
    build({
      entryPoints: ['src/renderer/app.ts'],
      outfile: `${OUT}/renderer/app.js`,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      sourcemap: true
    }),
    build({
      entryPoints: globSync('test/**/*.ts'),
      outdir: `${OUT}/test`,
      outbase: 'test',
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true
    })
  ]);

  cpSync('src/renderer/index.html', `${OUT}/renderer/index.html`);
  cpSync('src/renderer/style.css', `${OUT}/renderer/style.css`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
