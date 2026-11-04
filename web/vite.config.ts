import { defineConfig } from "vite";

// Local development: the gateway runs on 8080 with GATEWAY_PUBLIC_URL=http://localhost:5173, and Vite proxies
// every server route so cookies and redirects stay on one origin.
const gateway = "http://127.0.0.1:8080";
const proxied = ["/api", "/auth", "/oauth", "/mcp", "/.well-known"];

export default defineConfig({
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
  server: { port: 5173, strictPort: true, proxy: Object.fromEntries(proxied.map((path) => [path, { target: gateway, changeOrigin: false }])) },
});
