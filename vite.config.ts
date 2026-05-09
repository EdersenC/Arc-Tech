import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiHost = process.env.EXCALIDRAW_HOST || "127.0.0.1";
const apiPort = process.env.EXCALIDRAW_PORT || "8787";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`,
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false,
  },
});
