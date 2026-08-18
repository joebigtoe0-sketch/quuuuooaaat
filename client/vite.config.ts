import { defineConfig } from "vite";

import { resolve } from "node:path";

export default defineConfig({
  server: { port: 5199, host: "127.0.0.1" },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        wardrobe: resolve(__dirname, "wardrobe.html"),
      },
    },
  },
});
