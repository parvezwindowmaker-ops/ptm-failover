// Developer maintenance utility. Resolve stable registry versions before installing.
import { readFileSync, writeFileSync } from 'node:fs';
const production = [
  'react',
  'react-dom',
  'react-is',
  'react-router-dom',
  '@tanstack/react-query',
  'react-hook-form',
  '@hookform/resolvers',
  'zod',
  'lucide-react',
  'recharts',
  '@radix-ui/react-dialog',
  '@radix-ui/react-tabs',
  '@radix-ui/react-tooltip',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'fastify',
  '@fastify/cookie',
  '@fastify/static',
  '@fastify/helmet',
  '@fastify/rate-limit',
  '@fastify/swagger',
  'better-sqlite3',
  'argon2',
  '@aws-sdk/client-ec2',
  'ipaddr.js',
];
const development = [
  'typescript',
  'tsx',
  'vite',
  '@vitejs/plugin-react',
  'tailwindcss',
  '@tailwindcss/vite',
  'esbuild',
  'vitest',
  '@playwright/test',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@types/better-sqlite3',
  'eslint',
  '@eslint/js',
  'typescript-eslint',
  'eslint-plugin-react-hooks',
  'prettier',
];
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const [kind, names] of [
  ['dependencies', production],
  ['devDependencies', development],
]) {
  manifest[kind] =
    kind === 'dependencies'
      ? Object.fromEntries(
          Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith('@ptm/')),
        )
      : {};
  for (let i = 0; i < names.length; i += 4) {
    const results = await Promise.all(
      names.slice(i, i + 4).map(async (name) => {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`Registry ${name}: ${res.status}`);
        const data = await res.json();
        console.log(`${name}: ${data.version}`);
        return [name, data.version];
      }),
    );
    for (const [name, version] of results) manifest[kind][name] = version;
  }
}
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
