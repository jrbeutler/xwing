import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: true, port: 5173 },
  // Inline every asset (ship model, textures) as a data URI so the single-file artifact build is self-contained.
  build: { assetsInlineLimit: () => true },
});
