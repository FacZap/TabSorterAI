import { toMarkdown } from "./plan.js";

const $ = (id) => document.getElementById(id);
let entries = [];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast("Copied.");
}

async function remove(id) {
  entries = entries.filter((e) => e.id !== id);
  await chrome.storage.local.set({ archive: entries });
  render();
}

function matches(e, q) {
  if (!q) return true;
  const hay = [e.title, e.overview, ...(e.key_points ?? []), ...e.tabs.flatMap((t) => [t.title, t.url, t.summary])]
    .join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function render() {
  const q = $("search").value.trim().toLowerCase();
  const shown = entries.filter((e) => matches(e, q));
  $("count").textContent = `${entries.length} saved`;
  $("empty").hidden = entries.length > 0;

  $("list").replaceChildren(...shown.map((e) => {
    const links = e.tabs.map((t) => {
      // Only reopen web URLs; archived data is ours, but keep javascript: etc. out.
      const safe = /^(https?|file|ftp):/.test(t.url);
      return el("li", {},
        safe ? el("a", { href: t.url, target: "_blank", textContent: t.title }) : el("span", { textContent: t.title }),
        t.summary ? el("span", { class: "muted small", textContent: `— ${t.summary}` }) : null);
    });
    return el("div", { class: "card entry" },
      el("div", { class: "row wrap" },
        el("h2", { class: "grow", textContent: e.title }),
        el("span", { class: "muted small", textContent: new Date(e.date).toLocaleString() })),
      el("p", { textContent: e.overview }),
      e.key_points?.length ? el("ul", { class: "points" }, e.key_points.map((p) => el("li", { textContent: p }))) : null,
      el("details", {}, el("summary", { textContent: `${e.tabs.length} links` }), el("ul", { class: "links" }, links)),
      el("div", { class: "row" },
        el("button", {
          textContent: "Reopen all",
          onclick: () => chrome.windows.create({ url: e.tabs.map((t) => t.url).filter((u) => /^(https?|file|ftp):/.test(u)) }),
        }),
        el("button", { textContent: "Copy Markdown", onclick: () => copy(toMarkdown(e)) }),
        el("span", { class: "spacer" }),
        el("button", {
          class: "danger", textContent: "Delete",
          onclick: () => { if (confirm(`Delete "${e.title}" from the archive?`)) remove(e.id); },
        })));
  }));
}

$("search").oninput = render;
$("copyAll").onclick = () => copy(entries.map(toMarkdown).join("\n\n"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.archive) {
    entries = changes.archive.newValue ?? [];
    render();
  }
});

(async () => {
  entries = (await chrome.storage.local.get("archive")).archive ?? [];
  render();
})();
