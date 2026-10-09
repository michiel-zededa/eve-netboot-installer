import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build ends up in the web root of the PXE server (www/): index.html at
// the top, everything else under ui/. Relative paths, so it also works behind
// a reverse proxy or under another prefix. No CDN: PXE networks are often
// offline.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "ui/assets",
    emptyOutDir: true,
  },
  server: {
    // npm run dev: proxy the data of a running server, e.g.
    //   ENI_DEV_SERVER=http://192.168.1.10:8080 npm run dev
    proxy: process.env.ENI_DEV_SERVER
      ? { "/eve": process.env.ENI_DEV_SERVER, "/api": process.env.ENI_DEV_SERVER }
      : undefined,
    fs: { allow: [".."] },
  },
});
