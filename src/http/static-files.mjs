import fs from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"]
]);

export async function serveStaticAsset(url, response, config) {
  if (!config.static?.enabled) {
    return false;
  }

  const root = path.resolve(config.static.root ?? "public/matrix-edit");
  const index = config.static.index ?? "index.html";
  const filePath = resolveStaticPath(root, index, url.pathname);
  if (!filePath) {
    return false;
  }

  try {
    const file = await fs.readFile(filePath);
    const type = MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": filePath.endsWith(index) ? "no-cache" : "public, max-age=300",
      "Content-Type": type
    });
    response.end(file);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EISDIR") {
      throw error;
    }
    return false;
  }
}

function resolveStaticPath(root, index, pathname) {
  if (!isStaticRoute(pathname)) {
    return undefined;
  }

  const relative = pathname === "/" ? index : decodeURIComponent(pathname.replace(/^\/app\/?/, ""));
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  return resolved;
}

function isStaticRoute(pathname) {
  return pathname === "/" || pathname.startsWith("/app/");
}
