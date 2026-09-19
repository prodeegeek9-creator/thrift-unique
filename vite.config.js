import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The entry is app.html, not index.html, and that is deliberate.
//
// index.html at the repo root is the live single-store marketplace, and
// wrangler.jsonc serves the whole root directory as static assets. Naming this
// bundle's entry index.html would overwrite the running site the moment anyone
// deployed. So the dashboard is built and served at /app.html alongside the
// old pages, both reachable, until the cutover is a decision somebody makes on
// purpose rather than a side effect of a build.
//
// The cutover, when it comes, is three lines: rename app.html to index.html,
// point wrangler.jsonc's assets.directory at ./dist, and teach the build to
// copy whatever legacy pages still need to answer. See the README's
// "Cutover" section — it is the one step here that changes what a live URL
// serves, so it does not happen as part of a scaffold.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'app.html',
    },
  },
});
