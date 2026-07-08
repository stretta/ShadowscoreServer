export function editorManifests(config = {}) {
  const editors = Array.isArray(config.editors) ? config.editors : [];
  return editors.map(normalizeEditorManifest).filter(Boolean);
}

function normalizeEditorManifest(editor) {
  if (!editor || typeof editor !== "object" || Array.isArray(editor)) {
    return undefined;
  }
  const id = cleanToken(editor.id);
  const route = normalizeRoute(editor.route ?? `/editors/${id}`);
  if (!id || !route) {
    return undefined;
  }
  return withoutUndefined({
    id,
    label: stringField(editor.label) || titleCase(id),
    route,
    targetFilter: normalizeTargetFilter(editor.targetFilter),
    capabilities: Array.isArray(editor.capabilities)
      ? editor.capabilities.map(cleanToken).filter(Boolean)
      : undefined
  });
}

function normalizeTargetFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return {};
  }
  return Object.fromEntries(Object.entries({
    app: cleanToken(filter.app),
    capability: cleanToken(filter.capability),
    status: cleanToken(filter.status)
  }).filter(([, value]) => value));
}

function normalizeRoute(value) {
  const route = stringField(value);
  if (!route) {
    return "";
  }
  return route.startsWith("/") ? route : `/${route}`;
}

function titleCase(value) {
  return stringField(value).split(/[-_]+/g).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
