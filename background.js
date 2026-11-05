import { callClaude } from "./claude.js";
import { validatePlan, tabLabel, isOrganizable, COLORS } from "./plan.js";
import { getSettings } from "./settings.js";

// The popup closes whenever it loses focus, so Claude calls run here and their
// results sit in chrome.storage.session until the popup picks them up:
//   busy           - {text, since} while a call is in flight
//   lastError      - message of the last failed command
//   pendingPlan    - grouping proposal awaiting Apply
//   pendingSummary - summary awaiting Archive
//   undo           - layout snapshot taken before the last Apply

const session = chrome.storage.session;

// Let the popup (a trusted context anyway) and nothing else read session data.
session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.cmd];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err.message, kind: err.kind }),
  );
  return true; // async response
});

async function withBusy(text, fn) {
  // `since` lets the popup ignore a stale flag if the worker was killed mid-call.
  await session.set({ busy: { text, since: Date.now() }, lastError: null });
  // Any extension API call resets the worker's idle timer; a pending fetch
  // alone doesn't, and a slow call would otherwise be cut off at ~30 s.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await fn();
  } catch (e) {
    await session.set({ lastError: e.message });
    throw e;
  } finally {
    clearInterval(keepAlive);
    await session.set({ busy: null });
  }
}

function tabInfo(t) {
  return { id: t.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || "" };
}

async function queryScope(scope, windowId) {
  const all = scope === "all"
    ? await chrome.tabs.query({ windowType: "normal" })
    : await chrome.tabs.query({ windowId });
  return all;
}

// ---------------------------------------------------------------- organize

const GROUP_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          color: { type: "string", enum: COLORS },
          tabs: { type: "array", items: { type: "integer" } },
          existing: { type: "integer" },
        },
        required: ["name", "color", "tabs", "existing"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

const GROUP_SYSTEM = `You organize a user's browser tabs into tab groups.

Group by the task or topic the user is working on, not merely by website: tabs from the same site about unrelated things belong in different groups, and a task that spans several sites stays together. Aim for 2 to 12 groups in total, counting the user's existing groups. Prefer fewer, meaningful groups over many tiny ones, but do not lump unrelated tabs together just to reduce the count; a small "Other" group for true leftovers is fine.

Group names are 1-3 words, in the language most tab titles are written in. Give each group a different color where possible, also different from the existing groups.

Each tab line is: index<TAB>title<TAB>host/path. Every index must appear in exactly one group. Set "existing" to -1 for a new group.`;

const EXISTING_SYSTEM = `

The user already has tab groups, listed under "Existing groups" as G<number><TAB>name<TAB>color<TAB>sample tab titles. They made these on purpose, so prefer them: when tabs fit an existing group's topic, put them in a group whose "existing" is that group's number (G3 -> 3), keeping its name and color (if it has no name, give it one). Create new groups (existing = -1) only for tabs that fit no existing group. Use each existing group number at most once.`;

const KEEP_SYSTEM = `

Only ungrouped tabs are listed; the tabs already in existing groups stay there. Do not return groups for existing groups that receive no new tabs.`;

const REGROUP_SYSTEM = `

Every tab is listed; a tab already in an existing group ends with <TAB>in G<number>. Keep those tabs where they are unless one clearly belongs elsewhere.`;

const clean = (s, n) => (s || "").replace(/\s+/g, " ").slice(0, n);

async function organize({ scope, windowId }) {
  const settings = await getSettings();
  const scoped = await queryScope(scope, windowId);
  const organizable = scoped.filter((t) => isOrganizable(t, settings.includePinned));

  // Current groups that have tabs in scope, with a few titles so Claude can
  // tell what an unnamed group is about.
  const groupIds = [...new Set(scoped.map((t) => t.groupId).filter((id) => id !== -1))];
  const existing = [];
  for (const id of groupIds) {
    try {
      const g = await chrome.tabGroups.get(id);
      const members = scoped.filter((t) => t.groupId === id);
      existing.push({ id, title: g.title || "", color: g.color, count: members.length, samples: members.slice(0, 6).map((t) => clean(t.title, 60)) });
    } catch { /* closed since */ }
  }
  const keep = settings.keepGroups && existing.length > 0;

  const tabs = keep ? organizable.filter((t) => t.groupId === -1) : organizable;
  if (keep && !tabs.length) throw new Error("Every tab is already in a group. Turn off \"keep my groups\" to rearrange them.");
  // One loose tab is worth sorting when there are groups it could join.
  if (tabs.length < (existing.length ? 1 : 2)) throw new Error("Need at least 2 web tabs to organize.");

  return withBusy(`Grouping ${tabs.length} tabs…`, async () => {
    const gIndex = new Map(existing.map((g, i) => [g.id, i]));
    const tabLines = tabs.map((t, i) => {
      const where = !keep && gIndex.has(t.groupId) ? `\tin G${gIndex.get(t.groupId)}` : "";
      return `${i}\t${clean(t.title, 150)}\t${tabLabel(t.url)}${where}`;
    });
    let user = tabLines.join("\n");
    let system = GROUP_SYSTEM;
    if (existing.length) {
      const groupLines = existing.map((g, i) => `G${i}\t${g.title || "(no name)"}\t${g.color}\t${g.samples.join(" | ")}`);
      user = `Existing groups:\n${groupLines.join("\n")}\n\nTabs:\n${user}`;
      system += EXISTING_SYSTEM + (keep ? KEEP_SYSTEM : REGROUP_SYSTEM);
    }

    const { data, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.model,
      system,
      user,
      schema: GROUP_SCHEMA,
      maxTokens: Math.min(16000, 2048 + tabs.length * 16),
    });
    const groups = validatePlan(data, tabs.length, existing.length);
    const pendingPlan = {
      createdAt: Date.now(),
      scope,
      windowId,
      usage,
      keep,
      groups: groups.map((g) => {
        const ex = existing[g.existing];
        return {
          // An existing group keeps its own name and color unless it had none.
          name: ex?.title || g.name,
          color: ex ? ex.color : g.color,
          include: true,
          existing: ex ? { id: ex.id, title: ex.title, count: keep ? ex.count : 0 } : null,
          tabs: g.tabs.map((i) => tabInfo(tabs[i])),
        };
      }),
    };
    await session.set({ pendingPlan, pendingSummary: null });
    return { pendingPlan };
  });
}

// ---------------------------------------------------------------- apply / undo

async function snapshot() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const groups = await chrome.tabGroups.query({});
  return {
    takenAt: Date.now(),
    tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, index: t.index, groupId: t.groupId, pinned: t.pinned })),
    groups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed })),
  };
}

async function existingIds(ids) {
  const out = [];
  for (const id of ids) {
    try { await chrome.tabs.get(id); out.push(id); } catch { /* closed since */ }
  }
  return out;
}

// Pinned tabs can't join a group.
async function unpin(ids) {
  for (const id of ids) {
    const t = await chrome.tabs.get(id);
    if (t.pinned) await chrome.tabs.update(id, { pinned: false });
  }
}

async function applyPlan({ groups, mode, windowId }) {
  const wanted = groups.filter((g) => g.include && g.tabIds.length);
  if (!wanted.length) throw new Error("Nothing selected to apply.");

  return withBusy("Applying…", async () => {
    await session.set({ undo: await snapshot() });

    let target = windowId;
    try { await chrome.windows.get(target); } catch {
      target = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    }

    for (const g of wanted) {
      const ids = await existingIds(g.tabIds);
      if (!ids.length) continue;
      await unpin(ids);

      // An existing group that was closed since the preview becomes a new one.
      let current = null;
      if (g.groupId != null) {
        try { current = await chrome.tabGroups.get(g.groupId); } catch { /* gone */ }
      }

      if (current) {
        // tabs.group with groupId pulls the tabs into that group's window.
        const gid = await chrome.tabs.group({ groupId: current.id, tabIds: ids });
        if (mode === "windows") {
          // Groups move only into an existing window, so open one around a
          // blank tab and drop that tab once the group is in.
          const created = await chrome.windows.create({ focused: false });
          await chrome.tabGroups.move(gid, { windowId: created.id, index: -1 });
          await chrome.tabs.remove(created.tabs[0].id);
        } else if (current.windowId !== target) {
          await chrome.tabGroups.move(gid, { windowId: target, index: -1 });
        }
        await chrome.tabGroups.update(gid, { title: g.name, color: g.color });
        continue;
      }

      let win = target;
      if (mode === "windows") {
        const created = await chrome.windows.create({ tabId: ids[0], focused: false });
        win = created.id;
        if (ids.length > 1) await chrome.tabs.move(ids.slice(1), { windowId: win, index: -1 });
      }
      // tabs.group pulls tabs in from other windows when windowId is given.
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win } });
      await chrome.tabGroups.update(gid, { title: g.name, color: g.color, collapsed: false });
      // Keep the groups in plan order, after any ungrouped tabs.
      if (mode !== "windows") await chrome.tabGroups.move(gid, { index: -1 });
    }
    if (mode !== "windows") await chrome.windows.update(target, { focused: true });
    await session.set({ pendingPlan: null });
    return {};
  });
}

async function undo() {
  const { undo: snap } = await session.get("undo");
  if (!snap) throw new Error("Nothing to undo.");

  return withBusy("Restoring layout…", async () => {
    const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const tabs = snap.tabs.filter((t) => live.has(t.id));
    if (!tabs.length) throw new Error("None of those tabs are still open.");

    // Windows that closed during the apply (all their tabs moved out) are
    // recreated around their first surviving tab.
    const winMap = new Map();
    for (const wid of new Set(tabs.map((t) => t.windowId))) {
      try {
        await chrome.windows.get(wid);
        winMap.set(wid, wid);
      } catch {
        const first = tabs.filter((t) => t.windowId === wid).sort((a, b) => a.index - b.index)[0];
        const w = await chrome.windows.create({ tabId: first.id, focused: false });
        winMap.set(wid, w.id);
      }
    }

    await chrome.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {});

    const ordered = [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    for (const t of ordered) {
      const dest = { windowId: winMap.get(t.windowId), index: t.index };
      await chrome.tabs.move(t.id, dest).catch(() => chrome.tabs.move(t.id, { ...dest, index: -1 }));
    }

    // Recreate the groups that existed before.
    const byGroup = new Map();
    for (const t of tabs) {
      if (t.groupId === -1) continue;
      if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
      byGroup.get(t.groupId).push(t);
    }
    for (const [oldId, members] of byGroup) {
      const info = snap.groups.find((g) => g.id === oldId) ?? {};
      const gid = await chrome.tabs.group({
        tabIds: members.map((t) => t.id),
        createProperties: { windowId: winMap.get(members[0].windowId) },
      });
      await chrome.tabGroups.update(gid, {
        title: info.title ?? "", color: info.color ?? "grey", collapsed: !!info.collapsed,
      });
    }

    for (const t of tabs) if (t.pinned) await chrome.tabs.update(t.id, { pinned: true });

    await session.set({ undo: null });
    return {};
  });
}

// ---------------------------------------------------------------- summarize

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    key_points: { type: "array", items: { type: "string" } },
    tabs: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, summary: { type: "string" } },
        required: ["i", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "overview", "key_points", "tabs"],
  additionalProperties: false,
};

const SUMMARY_SYSTEM = `You write archive notes for a set of browser tabs the user is about to close, so they can later remember what they were doing and find things again.

Return:
- title: at most 8 words naming what these tabs are about.
- overview: 3-6 sentences on what the tabs cover as a whole and what the user seemed to be working on.
- key_points: 3-8 facts, decisions, comparisons or open questions worth keeping.
- tabs: one sentence per tab, by its index, saying what that page is and why it might matter.

Use only what is in the input. When a tab has nothing but a title, summarize what the title says rather than inventing details. Write in the language most of the tabs are in.`;

// Runs in the page. Kept self-contained: executeScript serializes it.
function extractPage(limit) {
  const meta = document.querySelector('meta[property="og:description"], meta[name="description"]');
  const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, limit);
  return { desc: (meta?.content || "").slice(0, 300), text };
}

async function readPage(tab, limit) {
  if (tab.discarded || !/^https?:/.test(tab.url)) return null;
  const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage, args: [limit] })
    .then((r) => r?.[0]?.result ?? null)
    .catch(() => null);
  const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
  return Promise.race([run, timeout]);
}

const MAX_SUMMARY_TABS = 150;
const DEEP_CHAR_BUDGET = 120_000;

async function summarize({ tabIds }) {
  const settings = await getSettings();
  const tabs = [];
  for (const id of tabIds) {
    try { tabs.push(await chrome.tabs.get(id)); } catch { /* closed */ }
  }
  if (!tabs.length) throw new Error("Those tabs are no longer open.");
  if (tabs.length > MAX_SUMMARY_TABS) throw new Error(`Summaries are limited to ${MAX_SUMMARY_TABS} tabs at a time.`);

  const deep = settings.deep && await chrome.permissions.contains({ origins: ["<all_urls>"] });

  return withBusy(`Summarizing ${tabs.length} tabs${deep ? " (reading pages)" : ""}…`, async () => {
    const limit = Math.min(4000, Math.floor(DEEP_CHAR_BUDGET / tabs.length));
    const pages = deep ? await Promise.all(tabs.map((t) => readPage(t, limit))) : tabs.map(() => null);

    const user = tabs.map((t, i) => {
      const parts = [`<tab index="${i}">`, `title: ${t.title || ""}`, `url: ${t.url}`];
      const p = pages[i];
      if (p?.desc) parts.push(`description: ${p.desc}`);
      if (p?.text) parts.push(`content: ${p.text}`);
      parts.push("</tab>");
      return parts.join("\n");
    }).join("\n\n");

    const { data, usage } = await callClaude({
      apiKey: settings.apiKey,
      model: settings.model,
      system: SUMMARY_SYSTEM,
      user,
      schema: SUMMARY_SCHEMA,
      maxTokens: Math.min(16000, 2048 + tabs.length * 80),
    });

    const perTab = new Map((data.tabs ?? []).map((t) => [t.i, t.summary]));
    const pendingSummary = {
      createdAt: Date.now(),
      usage,
      title: String(data.title || "Archived tabs").slice(0, 120),
      overview: String(data.overview || ""),
      key_points: (data.key_points ?? []).map(String),
      tabs: tabs.map((t, i) => ({ ...tabInfo(t), summary: perTab.get(i) ?? "" })),
    };
    await session.set({ pendingSummary });
    return { pendingSummary };
  });
}

// ---------------------------------------------------------------- archive

async function archive({ close, title }) {
  const { pendingSummary: s } = await session.get("pendingSummary");
  if (!s) throw new Error("No summary to archive.");

  const entry = {
    id: crypto.randomUUID(),
    date: Date.now(),
    title: (title || s.title).trim() || s.title,
    overview: s.overview,
    key_points: s.key_points,
    tabs: s.tabs.map(({ url, title: t, summary }) => ({ url, title: t, summary })),
  };
  const { archive: list = [] } = await chrome.storage.local.get("archive");
  await chrome.storage.local.set({ archive: [entry, ...list] });

  if (close) {
    const ids = await existingIds(s.tabs.map((t) => t.id));
    // Closing every open tab would quit Chrome; leave the archive page open.
    const remaining = (await chrome.tabs.query({ windowType: "normal" })).filter((t) => !ids.includes(t.id));
    if (!remaining.length) await chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") });
    await chrome.tabs.remove(ids);
  }

  // Tabs from the plan that were just closed must not stay in the preview.
  const { pendingPlan } = await session.get("pendingPlan");
  if (close && pendingPlan) {
    const gone = new Set(s.tabs.map((t) => t.id));
    for (const g of pendingPlan.groups) g.tabs = g.tabs.filter((t) => !gone.has(t.id));
    pendingPlan.groups = pendingPlan.groups.filter((g) => g.tabs.length);
    await session.set({ pendingPlan: pendingPlan.groups.length ? pendingPlan : null });
  }

  await session.set({ pendingSummary: null });
  return { entry };
}

// ---------------------------------------------------------------- router

const handlers = {
  organize,
  applyPlan,
  undo,
  summarize,
  archive,
  discardPlan: async () => { await session.set({ pendingPlan: null }); return {}; },
  discardSummary: async () => { await session.set({ pendingSummary: null }); return {}; },
  clearError: async () => { await session.set({ lastError: null }); return {}; },
};
