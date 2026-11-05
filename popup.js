import { COLORS, COLOR_HEX, isOrganizable } from "./plan.js";
import { getSettings, saveSettings, MODELS } from "./settings.js";

const $ = (id) => document.getElementById(id);
const session = chrome.storage.session;
const STALE_BUSY_MS = 120_000;
const TABS_SHOWN = 6; // per group before "show all"

let windowId;
let settings;
let state = {};           // mirror of chrome.storage.session
let lastPlanWrite = null; // JSON of our own last pendingPlan write, to skip its echo
const expanded = new Set();

// Tab titles are page-controlled: build DOM with textContent only.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function favicon(url) {
  if (!url || !/^(https?|data):/.test(url)) return el("span", { class: "fav blank" });
  const img = el("img", { class: "fav", src: url, alt: "" });
  img.addEventListener("error", () => img.replaceWith(el("span", { class: "fav blank" })));
  return img;
}

function usageText(u) {
  return u ? `${u.input_tokens.toLocaleString()} in · ${u.output_tokens.toLocaleString()} out tokens` : "";
}

async function send(cmd, payload = {}) {
  const res = await chrome.runtime.sendMessage({ cmd, ...payload });
  if (!res?.ok) {
    // The worker already stored lastError; the storage listener shows it.
    if (res?.kind === "auth") $("keyBanner").hidden = false;
  }
  return res;
}

// ---------------------------------------------------------------- render

function isBusy() {
  return state.busy && Date.now() - state.busy.since < STALE_BUSY_MS;
}

function render() {
  const busy = isBusy();
  $("busy").hidden = !busy;
  $("busyText").textContent = busy ? state.busy.text : "";
  $("error").hidden = !state.lastError;
  $("errorText").textContent = state.lastError || "";
  for (const b of document.querySelectorAll("main button:not(.link)")) b.disabled = busy;

  const view = state.pendingSummary ? "summary" : state.pendingPlan ? "plan" : "home";
  $("home").hidden = view !== "home";
  $("planView").hidden = view !== "plan";
  $("summaryView").hidden = view !== "summary";
  $("undoRow").hidden = !state.undo;

  if (view === "plan") renderPlan();
  if (view === "summary") renderSummary();
}

function savePlan() {
  lastPlanWrite = JSON.stringify(state.pendingPlan);
  session.set({ pendingPlan: state.pendingPlan });
}

function renderPlan() {
  const plan = state.pendingPlan;
  const total = plan.groups.reduce((n, g) => n + g.tabs.length, 0);
  const reused = plan.groups.filter((g) => g.existing).length;
  $("planTitle").textContent = `${plan.groups.length} groups${reused ? ` (${reused} existing)` : ""} · ${total} tabs`;
  $("planUsage").textContent = usageText(plan.usage);

  const names = plan.groups.map((g) => g.name);
  const box = $("groups");
  box.replaceChildren(...plan.groups.map((g, gi) => {
    const dot = el("button", {
      class: "dot", title: `Color: ${g.color} (click to change)`,
      style: { background: COLOR_HEX[g.color], border: "none", padding: 0, width: "14px", height: "14px" },
      onclick: () => {
        g.color = COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length];
        savePlan(); render();
      },
    });
    const name = el("input", {
      type: "text", value: g.name, maxLength: 40,
      oninput: (e) => { g.name = e.target.value; savePlan(); },
    });
    const include = el("input", {
      type: "checkbox", checked: g.include, title: "Include this group when applying",
      onchange: (e) => { g.include = e.target.checked; savePlan(); render(); },
    });
    const archiveBtn = el("button", {
      class: "link small", textContent: "summarize",
      title: "Summarize and archive just this group",
      onclick: () => send("summarize", { tabIds: g.tabs.map((t) => t.id) }),
    });

    const showAll = expanded.has(gi) || g.tabs.length <= TABS_SHOWN + 1;
    const shown = showAll ? g.tabs : g.tabs.slice(0, TABS_SHOWN);
    const items = shown.map((t) => {
      const move = el("select", {
        title: "Move to another group",
        onchange: (e) => {
          const to = Number(e.target.value);
          g.tabs = g.tabs.filter((x) => x.id !== t.id);
          plan.groups[to].tabs.push(t);
          plan.groups = plan.groups.filter((x) => x.tabs.length);
          savePlan(); render();
        },
      }, names.map((n, i) => el("option", { value: i, textContent: n || `Group ${i + 1}`, selected: i === gi })));
      return el("li", { class: "row" },
        favicon(t.favIconUrl),
        el("span", { class: "ellipsis", textContent: t.title, title: t.url }),
        move);
    });

    return el("div", { class: `card group${g.include ? "" : " off"}` },
      el("div", { class: "row group-head" },
        include, dot, name,
        g.existing ? el("span", {
          class: "badge muted",
          textContent: g.existing.count ? `existing +${g.tabs.length}` : "existing",
          title: g.existing.count
            ? `Adds ${g.tabs.length} tab(s) to your group "${g.existing.title || "unnamed"}", which already has ${g.existing.count}`
            : `Reuses your group "${g.existing.title || "unnamed"}"`,
        }) : null,
        el("span", { class: "muted small count", textContent: g.tabs.length }),
        archiveBtn),
      el("ul", { class: "tab-list" }, items),
      showAll ? null : el("button", {
        class: "link small more", textContent: `show all ${g.tabs.length}`,
        onclick: () => { expanded.add(gi); render(); },
      }));
  }));

  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === settings.applyMode;
}

function renderSummary() {
  const s = state.pendingSummary;
  const title = $("sumTitle");
  if (document.activeElement !== title) title.value = s.title;
  $("sumOverview").textContent = s.overview;
  $("sumPoints").replaceChildren(...s.key_points.map((p) => el("li", { textContent: p })));
  $("sumTabs").replaceChildren(...s.tabs.map((t) =>
    el("div", { class: "row t" },
      favicon(t.favIconUrl),
      el("div", { class: "grow" },
        el("div", { class: "ellipsis", textContent: t.title, title: t.url }),
        t.summary ? el("div", { class: "muted small", textContent: t.summary }) : null))));
  $("sumUsage").textContent = usageText(s.usage);
  $("archiveClose").textContent = `Archive & close ${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- actions

$("organize").onclick = async () => {
  const scope = $("scope").value;
  await saveSettings({ scope });
  send("organize", { scope, windowId });
};

$("keepGroups").onchange = (e) => saveSettings({ keepGroups: e.target.checked });

$("undo").onclick = () => send("undo");

$("summarize").onclick = async () => {
  const query = $("sumTarget").value === "highlighted"
    ? { windowId, highlighted: true }
    : { windowId };
  const tabs = (await chrome.tabs.query(query)).filter((t) => isOrganizable(t, true));
  if (!tabs.length) {
    await session.set({ lastError: "No web tabs to summarize there." });
    return;
  }
  send("summarize", { tabIds: tabs.map((t) => t.id) });
};

$("deep").onchange = async (e) => {
  let on = e.target.checked;
  if (on) on = await chrome.permissions.request({ origins: ["<all_urls>"] });
  e.target.checked = on;
  settings.deep = on;
  await saveSettings({ deep: on });
};

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.onchange = () => { settings.applyMode = r.value; saveSettings({ applyMode: r.value }); };
}

$("applyPlan").onclick = () => {
  const groups = state.pendingPlan.groups.map((g) => ({
    name: g.name.trim() || "Group", color: g.color, include: g.include, tabIds: g.tabs.map((t) => t.id),
    groupId: g.existing?.id ?? null,
  }));
  send("applyPlan", { groups, mode: settings.applyMode, windowId });
};

$("discardPlan").onclick = () => send("discardPlan");
$("discardSummary").onclick = () => send("discardSummary");
$("saveOnly").onclick = () => send("archive", { close: false, title: $("sumTitle").value });
$("archiveClose").onclick = () => send("archive", { close: true, title: $("sumTitle").value });
$("errorClose").onclick = () => send("clearError");

// ---------------------------------------------------------------- init

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (k === "pendingPlan" && newValue && JSON.stringify(newValue) === lastPlanWrite) continue;
    if (k === "pendingPlan" && newValue?.createdAt !== state.pendingPlan?.createdAt) expanded.clear();
    state[k] = newValue;
  }
  render();
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  settings = await getSettings();
  state = await session.get(null);

  $("scope").value = settings.scope;
  $("keepGroups").checked = settings.keepGroups;
  $("deep").checked = settings.deep && await chrome.permissions.contains({ origins: ["<all_urls>"] });
  $("keyBanner").hidden = !!settings.apiKey;
  $("modelTag").textContent = MODELS.find((m) => m.id === settings.model)?.label.replace(/ \(.*/, "") ?? settings.model;

  const highlighted = await chrome.tabs.query({ windowId, highlighted: true });
  $("sumTarget").options[0].textContent = `Selected tabs in this window (${highlighted.length})`;

  render();
  // Re-check a stale busy flag once it expires.
  if (state.busy) setTimeout(render, STALE_BUSY_MS);
})();
