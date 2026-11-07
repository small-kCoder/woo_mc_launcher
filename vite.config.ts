import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 渲染进程构建配置：产物为相对路径，便于 Electron 以 file:// 加载
export default defineConfig({
  // 默认 root 即为项目根目录
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
