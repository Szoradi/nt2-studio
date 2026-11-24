import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Relative base so the built app can be hosted from any folder.
// The version shown on the splash screen is the one in package.json
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5173, strictPort: false },
});
