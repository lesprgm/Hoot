import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // nut.js loads a platform-native .node binding at runtime. Keep the package
    // outside Rollup's main-process bundle so its loader resolves that binding
    // from node_modules instead of looking beside the generated bundle.
    plugins: [externalizeDepsPlugin({ include: ["@nut-tree-fork/nut-js"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
