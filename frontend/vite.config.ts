import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: process.env.DEV_HOST ? [process.env.DEV_HOST] : [],
    watch: { usePolling: process.env.DOCKER_DEV === "1" },
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
});
