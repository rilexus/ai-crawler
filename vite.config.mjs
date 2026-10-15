import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// public/index.html is the entry page and loads /src/index.jsx, which the
// alias maps to the src/ folder outside the Vite root.
// The build goes to dist/web so it doesn't wipe the esbuild bundle in dist/.
export default defineConfig({
  root: "public",
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: { "/src": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Forward API calls to the Express server in app/index.js.
  server: {
    proxy: { "/api": "http://localhost:3000" },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
