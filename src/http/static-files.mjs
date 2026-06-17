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

  const app = staticAppForPath(config.static, url.pathname);
  if (!app) {
    return false;
  }

  const root = path.resolve(app.root);
  const index = app.index;
  const filePath = resolveStaticPath(root, index, app.route, url.pathname);
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

function staticAppForPath(staticConfig, pathname) {
  for (const app of staticApps(staticConfig)) {
    const route = app.routes.find((entry) => matchesRoute(pathname, entry));
    if (route) {
      return { ...app, route };
    }
  }
  return undefined;
}

function staticApps(staticConfig) {
  const configuredApps = Object.values(staticConfig.apps ?? {});
  if (configuredApps.length) {
    return configuredApps.map(normalizeStaticApp).filter(Boolean);
  }
  return [
    normalizeStaticApp({
      root: staticConfig.root,
      index: staticConfig.index,
      routes: ["/", "/app"]
    })
  ].filter(Boolean);
}

function normalizeStaticApp(app) {
  if (!app?.root) {
    return undefined;
  }
  const routes = Array.isArray(app.routes) ? app.routes : [app.route ?? "/app"];
  return {
    root: app.root,
    index: app.index ?? "index.html",
    routes: routes.map(normalizeRoute)
  };
}

function normalizeRoute(route) {
  const normalized = `/${String(route ?? "").replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/" : normalized;
}

function matchesRoute(pathname, route) {
  if (route === "/") {
    return pathname === "/";
  }
  return pathname === route || pathname.startsWith(`${route}/`);
}

function resolveStaticPath(root, index, route, pathname) {
  const relative = pathname === route || (route === "/" && pathname === "/")
    ? index
    : decodeURIComponent(pathname.slice(route.length).replace(/^\/+/, ""));
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  return resolved;
}
