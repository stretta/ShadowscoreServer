export const shadowScoreNavigation = Object.freeze([
  Object.freeze({
    id: "shadowscore",
    label: "ShadowScore",
    items: Object.freeze([
      Object.freeze({ label: "Piano Roll", href: "/piano-roll" }),
      Object.freeze({ label: "Matrix", href: "/matrix-edit", prefix: true }),
      Object.freeze({ label: "Event List", href: "/event-list" })
    ])
  }),
  Object.freeze({
    id: "arrange",
    label: "Arrange",
    href: "/structure-editor"
  }),
  Object.freeze({
    id: "osc",
    label: "OSC",
    items: Object.freeze([
      Object.freeze({ label: "OSC Overview", href: "/editors" }),
      Object.freeze({ label: "Analog Sequencer", href: "/editors/analogsequencer" }),
      Object.freeze({ label: "List Sequencer", href: "/editors/listsequencer" }),
      Object.freeze({ label: "List Velocity Sequencer", href: "/editors/listvelsequencer" }),
      Object.freeze({ label: "Element", href: "/editors/element" }),
      Object.freeze({ label: "Poland", href: "/editors/poland" }),
      Object.freeze({ label: "Plate", href: "/editors/plate" }),
      Object.freeze({ label: "Soft Piano", href: "/editors/softpiano" }),
      Object.freeze({ label: "TTID", href: "/editors/ttid" }),
      Object.freeze({ label: "OSC Volume", href: "/tools/osc-volume" }),
      Object.freeze({ label: "OSC Macros", href: "/tools/osc-macros" })
    ])
  }),
  Object.freeze({
    id: "setup",
    label: "Setup",
    items: Object.freeze([
      Object.freeze({ label: "Dashboard", href: "/" }),
      Object.freeze({ label: "Admin", href: "/admin" }),
      Object.freeze({ label: "Transport", href: "/transport/status" })
    ])
  })
]);

export function renderShadowScoreNavigation(root, options = {}) {
  if (!(root instanceof HTMLElement)) {
    throw new TypeError("navigation root must be an HTMLElement");
  }
  const pathname = options.pathname ?? `${window.location.pathname}${window.location.hash}`;
  root.classList.add("ss-route-tabs", "ss-grouped-nav");
  root.dataset.enhanced = "true";
  root.replaceChildren(...shadowScoreNavigation.map((group) => (
    group.href ? directLink(group, pathname) : menuGroup(group, pathname)
  )));
  bindMenuBehavior(root);
  return root;
}

export function activeNavigationForPath(value) {
  const pathname = String(value ?? "/");
  for (const group of shadowScoreNavigation) {
    if (group.href && matchesPath(pathname, group)) {
      return { groupId: group.id, groupLabel: group.label, itemLabel: group.label };
    }
    const item = group.items?.find((candidate) => matchesPath(pathname, candidate));
    if (item) {
      return { groupId: group.id, groupLabel: group.label, itemLabel: item.label };
    }
  }
  return null;
}

function directLink(group, pathname) {
  const link = document.createElement("a");
  link.className = "ss-nav-primary";
  link.href = group.href;
  link.textContent = group.label;
  link.dataset.group = group.id;
  if (matchesPath(pathname, group)) {
    link.setAttribute("aria-current", "page");
  }
  return link;
}

function menuGroup(group, pathname) {
  const details = document.createElement("details");
  details.className = "ss-nav-group";
  details.dataset.group = group.id;
  const currentItem = group.items.find((item) => matchesPath(pathname, item));
  if (currentItem) {
    details.dataset.current = "true";
  }

  const summary = document.createElement("summary");
  summary.className = "ss-nav-primary";
  summary.textContent = group.label;
  summary.setAttribute("aria-label", `${group.label} menu`);
  if (currentItem) {
    summary.setAttribute("aria-current", "page");
  }

  const menu = document.createElement("div");
  menu.className = "ss-nav-menu";
  menu.setAttribute("role", "menu");
  group.items.forEach((item) => {
    const link = document.createElement("a");
    link.href = item.href;
    link.textContent = item.label;
    link.setAttribute("role", "menuitem");
    if (matchesPath(pathname, item)) {
      link.setAttribute("aria-current", "page");
    }
    menu.append(link);
  });
  details.append(summary, menu);
  return details;
}

function bindMenuBehavior(root) {
  const groups = [...root.querySelectorAll(".ss-nav-group")];
  groups.forEach((group) => {
    group.addEventListener("toggle", () => {
      if (!group.open) return;
      groups.forEach((other) => {
        if (other !== group) other.open = false;
      });
    });
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !group.open) return;
      event.preventDefault();
      group.open = false;
      group.querySelector("summary")?.focus();
    });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) {
      groups.forEach((group) => {
        group.open = false;
      });
    }
  });
}

function matchesPath(pathname, item) {
  const [rawPath, rawHash = ""] = String(pathname ?? "/").split("#", 2);
  const [rawHrefPath, hrefHash = ""] = String(item.href ?? "/").split("#", 2);
  if (hrefHash && rawHash !== hrefHash) return false;
  const currentPath = normalizePath(rawPath);
  const hrefPath = normalizePath(rawHrefPath);
  if (hrefPath === "/") return currentPath === "/";
  return item.prefix ? currentPath === hrefPath || currentPath.startsWith(`${hrefPath}/`) : currentPath === hrefPath;
}

function normalizePath(value) {
  const pathname = String(value ?? "/").split(/[?#]/, 1)[0] || "/";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-shadow-nav]").forEach((root) => {
    renderShadowScoreNavigation(root);
  });
}
