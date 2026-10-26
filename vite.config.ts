import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri 期望一个固定端口的开发服务器，且不能清屏（会吞掉 Rust 端日志）
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 注意：这里是 ESM 配置，"__dirname" 不存在，必须用 import.meta.url
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: {
      // Rust 侧文件由 cargo 自己 watch，忽略掉避免无谓重载
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Windows 上是 WebView2 (Chromium 105+)，macOS/Linux 为 WebKit
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
