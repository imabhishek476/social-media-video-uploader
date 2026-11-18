import { defineConfig } from 'tsup';

// Bundle the API plus internal @shorts/* workspace packages (which ship TS
// source) into dist/; third-party dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts', 'src/scripts/seed-admin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Inline internal workspace packages (TS source); keep every third-party
  // package external (e.g. BullMQ loads Lua scripts from its install dir).
  noExternal: [/^@shorts\//],
  external: [/^(?!@shorts\/)[@a-z]/],
});
