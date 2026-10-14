import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: ['apps/api/src/server.ts'],
  outfile: 'dist/server.mjs',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  packages: 'bundle',
  external: ['better-sqlite3', 'argon2', 'ssh2'],
  banner: {
    js: "import { createRequire as __ptmCreateRequire } from 'node:module'; const require = __ptmCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'workspace',
      setup(b) {
        b.onResolve({ filter: /^@ptm\// }, (args) => ({
          path: fileURLToPath(new URL(`../packages/${args.path.slice(5)}/src/index.ts`, import.meta.url)),
        }));
      },
    },
  ],
});
