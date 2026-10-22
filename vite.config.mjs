import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// workflow/web/index.html is the entry page and loads ./index.jsx next to it.
// The build goes to dist/web so it doesn't wipe the esbuild bundle in dist/.
export default defineConfig({
  root: "workflow/web",
  publicDir: false,
  plugins: [react()],
  // Forward the WebSocket to the server in workflow/server/index.js.
  server: {
    proxy: { "/ws": { target: "ws://localhost:3000", ws: true } },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
