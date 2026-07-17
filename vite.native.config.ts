import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "native",
  base: "./",
  publicDir: "../native-public",
  plugins: [react()],
  build: {
    outDir: "../native-dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
