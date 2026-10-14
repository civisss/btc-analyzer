import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// API_TARGET (env) punta il dev server a un backend diverso; default: backend su :8010 (127.0.0.1: su localhost/::1 la 8000-8010 può essere di altri container)
const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const API_TARGET = env.API_TARGET || 'http://127.0.0.1:8010'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts', 'echarts-for-react'],
          lwc: ['lightweight-charts'],
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
})
