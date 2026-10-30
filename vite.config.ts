import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT || 5173),
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3211', changeOrigin: false } },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'react';
          if (/[/\\](motion|framer-motion|motion-dom|motion-utils)[/\\]/.test(id)) return 'motion';
          return 'vendor';
        },
      },
    },
  },
});
