// Pure helpers, no chrome.* calls, so they can be tested in node.

export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// Swatches roughly matching Chrome's dark-theme tab group colors.
export const COLOR_HEX = {
  grey: "#9aa0a6", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663", green: "#81c995",
  pink: "#ff8bcb", purple: "#c58af9", cyan: "#78d9ec", orange: "#fcad70",
};

// Model output -> groups of tab indices. Every index in [0, count) ends up in
// exactly one group: unknown and repeated indices are dropped, and whatever
// the model left out goes to "Other". `existing` is the index of a current
// tab group the plan group extends, or -1 for a new one; each current group
// can be extended by one plan group only.
export function validatePlan(raw, count, existingCount = 0) {
  const seen = new Set();
  const usedExisting = new Set();
  const groups = [];
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    const tabs = [];
    for (const i of Array.isArray(g?.tabs) ? g.tabs : []) {
      if (Number.isInteger(i) && i >= 0 && i < count && !seen.has(i)) {
        seen.add(i);
        tabs.push(i);
      }
    }
    if (!tabs.length) continue;
    const name = String(g.name ?? "").trim().slice(0, 40) || `Group ${groups.length + 1}`;
    const color = COLORS.includes(g.color) ? g.color : COLORS[groups.length % COLORS.length];
    let existing = -1;
    const e = g.existing;
    if (Number.isInteger(e) && e >= 0 && e < existingCount && !usedExisting.has(e)) {
      usedExisting.add(e);
      existing = e;
    }
    groups.push({ name, color, tabs, existing });
  }
  const missing = [];
  for (let i = 0; i < count; i++) if (!seen.has(i)) missing.push(i);
  if (missing.length) {
    const other = groups.find((g) => g.name.toLowerCase() === "other");
    if (other) other.tabs.push(...missing);
    else groups.push({ name: "Other", color: "grey", tabs: missing, existing: -1 });
  }
  return groups;
}

// host + path, no scheme or query: enough for topic, cheap in tokens.
export function tabLabel(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, "").slice(0, 120);
  } catch {
    return String(url).slice(0, 120);
  }
}

export function isOrganizable(tab, includePinned) {
  if (tab.pinned && !includePinned) return false;
  return /^(https?|file|ftp):/.test(tab.url || tab.pendingUrl || "");
}

export function toMarkdown(entry) {
  const lines = [`## ${entry.title}`, "", `_${new Date(entry.date).toLocaleString()}_`, "", entry.overview, ""];
  if (entry.key_points?.length) {
    for (const p of entry.key_points) lines.push(`- ${p}`);
    lines.push("");
  }
  for (const t of entry.tabs) {
    lines.push(`- [${t.title.replace(/[[\]]/g, "")}](${t.url})${t.summary ? ` — ${t.summary}` : ""}`);
  }
  return lines.join("\n");
}
