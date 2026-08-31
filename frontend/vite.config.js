import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Vite does not populate process.env from .env files for the config file
  // itself (only for client code, via import.meta.env) — loadEnv() reads
  // frontend/.env explicitly so DEV_API_TARGET below is applied.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],

    // Speed up dev-server cold start by pre-bundling the heaviest imports.
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-router-dom', 'framer-motion'],
    },

    server: {
      port: 5173,
      proxy: {
        // All /api/* requests forwarded to the Express backend. Overridable so
        // the API can run on another port when 5001 is already taken.
        '/api': {
          target: env.DEV_API_TARGET || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },

    build: {
      // Target modern browsers — avoids legacy transforms and produces smaller
      // output without a separate Babel/SWC pass.
      target: 'es2020',
      outDir: 'dist',
      emptyOutDir: true,
      // Warn at 600 KB per chunk instead of 1 MB — keeps bundle discipline.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            // Core React runtime — changes rarely, long cache lifetime.
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            // Animation library — sizeable and independent of React internals.
            'vendor-motion': ['framer-motion'],
            // Icon set — tree-shaken by Rollup but isolated so a Lucide update
            // does not bust the React or Motion chunk.
            'vendor-icons': ['lucide-react'],
          },
        },
      },
    },
  };
});
