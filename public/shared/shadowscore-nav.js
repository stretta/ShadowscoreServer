import "./bipolar-range.js";

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
      Object.freeze({ label: "Trigger Sequencer", href: "/editors/triggersequencer" }),
      Object.freeze({ label: "List Sequencer", href: "/editors/listsequencer" }),
      Object.freeze({ label: "List Velocity Sequencer", href: "/editors/listvelsequencer" }),
      Object.freeze({ label: "Element", href: "/editors/element" }),
      Object.freeze({ label: "Vantor", href: "/editors/vantor" }),
      Object.freeze({ label: "Drumbox", href: "/editors/drumbox" }),
      Object.freeze({ label: "Poland", href: "/editors/poland" }),
      Object.freeze({ label: "Plate", href: "/editors/plate" }),
      Object.freeze({ label: "Soft Piano", href: "/editors/softpiano" }),
      Object.freeze({ label: "SingleHalfKrell", href: "/editors/singlehalfkrell" }),
      Object.freeze({ label: "Block Attributes", href: "/editors/ttid" }),
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
  const transferNavigation = transferNavigationGroup();
  root.replaceChildren(
    ...shadowScoreNavigation.map((group) => (
      group.href ? directLink(group, pathname) : menuGroup(group, pathname)
    )),
    transferNavigation.root
  );
  bindMenuBehavior(root);
  transferNavigation.connect();
  return root;
}

export function transferNavigationPresentation(transfers = {}) {
  const records = Object.values(transfers.targets ?? {});
  const summary = transfers.summary ?? {};
  const total = Number(summary.targetCount ?? records.length);
  const inProgress = Number(summary.inProgressCount ?? 0);
  const failed = Number(summary.failedCount ?? 0);
  const ready = Number(summary.readyCount ?? 0);
  const live = Number(summary.liveCount ?? 0);
  if (!total) return { label: "Players", tone: "", detail: "No transfer recorded yet", records };
  if (failed) return { label: `Players · ${failed} failed`, tone: "bad", detail: `${failed} player transfer${failed === 1 ? "" : "s"} failed`, records };
  if (inProgress) return { label: `Players · ${ready + live}/${total}`, tone: "warn", detail: `${inProgress} receiving · ${ready} ready · ${live} live`, records };
  if (ready) return { label: `Players · ${ready} ready`, tone: "ok", detail: `${ready} ready · ${live} live`, records };
  if (live === total) return { label: "Players · live", tone: "ok", detail: "All tracked players live", records };
  return { label: `Players · ${total}`, tone: "", detail: `${total} players tracked`, records };
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

function transferNavigationGroup() {
  const root = document.createElement("details");
  root.className = "ss-nav-group ss-transfer-nav";
  const summary = document.createElement("summary");
  summary.className = "ss-nav-primary ss-transfer-nav-summary";
  summary.textContent = "Players";
  const menu = document.createElement("div");
  menu.className = "ss-nav-menu ss-transfer-nav-menu";
  const aggregate = document.createElement("div");
  aggregate.className = "ss-transfer-nav-aggregate";
  aggregate.textContent = "Waiting for transfer status…";
  const rows = document.createElement("div");
  rows.className = "ss-transfer-nav-rows";
  menu.append(aggregate, rows);
  root.append(summary, menu);

  function render(transfers) {
    const presentation = transferNavigationPresentation(transfers);
    summary.textContent = presentation.label;
    summary.className = `ss-nav-primary ss-transfer-nav-summary${presentation.tone ? ` ${presentation.tone}` : ""}`;
    aggregate.textContent = presentation.detail;
    rows.replaceChildren(...presentation.records
      .sort((a, b) => String(a.voiceId || a.targetId).localeCompare(String(b.voiceId || b.targetId)))
      .map(transferNavigationRow));
  }

  function connect() {
    if (typeof EventSource !== "function") return;
    const events = new EventSource("/rnbo/transfers/events");
    events.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
    events.addEventListener("error", () => {
      if (!rows.children.length) aggregate.textContent = "Transfer status reconnecting…";
    });
  }

  return { root, connect };
}

function transferNavigationRow(record) {
  const row = document.createElement("div");
  row.className = "ss-transfer-nav-row";
  const name = document.createElement("strong");
  name.textContent = record.voiceId || record.targetId || "Player";
  const detail = document.createElement("span");
  detail.className = transferNavigationTone(record.state);
  detail.textContent = transferNavigationDetail(record);
  row.append(name, detail);
  return row;
}

function transferNavigationDetail(record) {
  const expected = Math.max(0, Number(record.expectedRows) || 0);
  const sent = Math.min(expected, Math.max(0, Number(record.sentRows) || 0));
  const confirmed = Math.min(expected, Math.max(0, Number(record.confirmedRows) || 0));
  if (record.state === "sending") return `Sending ${sent}/${expected}`;
  if (record.state === "awaiting-ack") return `Sent ${sent}/${expected} · awaiting ACK`;
  if (record.state === "retrying") return `Resume ${confirmed}/${expected} · retry ${record.attempt ?? ""}`.trim();
  if (record.state === "ready") return `Ready · ${confirmed}/${expected}`;
  if (record.state === "applying") return "Applying next beat";
  if (record.state === "live") return `Live · txn ${record.liveTransaction ?? record.transactionId ?? ""}`.trim();
  if (["failed", "activation-failed"].includes(record.state)) return `Failed · ${record.error || record.state}`;
  return record.state || "Tracked";
}

function transferNavigationTone(state) {
  if (["ready", "live"].includes(state)) return "ok";
  if (["failed", "activation-failed"].includes(state)) return "bad";
  return "warn";
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
