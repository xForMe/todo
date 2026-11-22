import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// FastAPI serves the generated browser bundle, never the React source tree.
export default defineConfig({
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: fileURLToPath(new URL('./public/dist', import.meta.url)),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('./src/workbench-entry.jsx', import.meta.url)),
      name: 'TodoReactWorkbench',
      formats: ['iife'],
      fileName: () => 'workbench-react.js',
    },
  },
});
