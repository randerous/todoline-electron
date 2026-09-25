import { defineConfig } from 'vite';
export default defineConfig({ root: 'src/renderer', base: './', build: { outDir: '../../out/renderer', emptyOutDir: true, target: 'es2022',rollupOptions:{input:['src/renderer/index.html','src/renderer/reminder.html']} } });
