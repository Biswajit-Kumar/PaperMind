import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Bind all interfaces (IPv4 + IPv6). Without this, Vite on some Windows
    // setups listens on [::1] only, so a browser hitting 127.0.0.1:5173 gets
    // "connection refused" while localhost/curl (which resolve to ::1) work -
    // which silently breaks every emailed verification / reset link.
    host: true,
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently moving to 5174 -
    // the verification / password-reset email links are built for :5173
    // (FRONTEND_URL), so a drifting dev port breaks every emailed link.
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost"],
  },
});
