import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: join(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: { outDir: join(__dirname, 'dist/renderer'), emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 800 },
  server: { port: 5173, strictPort: false },
});
