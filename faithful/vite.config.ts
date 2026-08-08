import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    // three.js is by far the largest dependency; splitting it lets the rest of
    // the site parse and start the cold open without waiting on it.
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
})
