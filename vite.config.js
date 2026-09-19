import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Vite inlines VITE_-prefixed variables at build time, which means a build run
// without them does not fail — it quietly produces a bundle that points every
// request at `undefined`. The dashboard then loads, looks perfectly normal and
// never shows a row, and the cause is a missing variable on a CI project two
// systems away.
//
// So the build refuses instead. A red build names the problem; a green build
// that ships a dead app does not.
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');

  if (command === 'build') {
    const missing = REQUIRED.filter((key) => !env[key]);
    if (missing.length) {
      throw new Error(
        `Cannot build without ${missing.join(' and ')}.\n` +
          'These are read at BUILD time. Set them as build environment ' +
          'variables on the Cloudflare project (not as Worker secrets, which ' +
          'are only readable at request time), or in .env for local work.'
      );
    }
  }

  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
