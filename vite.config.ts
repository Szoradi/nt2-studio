import { defineConfig } from 'vite';

// Relative base so the built app can be hosted from any folder.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
});
