import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // Netlify redirects cannot carry WebSocket upgrades, so production must call
  // the API on its own origin. Without VITE_API_URL the app falls back to the
  // relative "/api" base — REST would work through nothing at all, and realtime
  // would silently never connect. Fail the deploy instead of shipping that.
  // Netlify sets NETLIFY=true in its build image; local `pnpm build` is exempt.
  if (mode === "production" && process.env.NETLIFY && !process.env.VITE_API_URL) {
    throw new Error(
      "VITE_API_URL is required for a Netlify production build (e.g. https://api.convo.fawzxenon.com)",
    );
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: process.env.VITE_API_PROXY ?? "http://localhost:4000",
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
