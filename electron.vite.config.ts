import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: 'src/main/index.ts', 'speech-worker': 'src/main/speech-worker.ts' } } },
  },
  preload: {},
  renderer: { plugins: [vue()] },
})
