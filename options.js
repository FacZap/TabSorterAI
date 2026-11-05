import { getSettings, saveSettings, MODELS } from "./settings.js";
import { testKey } from "./claude.js";

const $ = (id) => document.getElementById(id);

function status(text, cls = "") {
  $("keyStatus").textContent = text;
  $("keyStatus").className = `small ${cls}`;
}

(async () => {
  const s = await getSettings();

  for (const m of MODELS) $("model").append(new Option(m.label, m.id, false, m.id === s.model));
  $("apiKey").value = s.apiKey;
  $("scope").value = s.scope;
  $("includePinned").checked = s.includePinned;

  $("saveKey").onclick = async () => {
    await saveSettings({ apiKey: $("apiKey").value.trim() });
    status("Saved.", "ok");
  };
  $("testKey").onclick = async () => {
    status("Testing…");
    try {
      await testKey($("apiKey").value.trim());
      status("Key works.", "ok");
    } catch (e) {
      status(e.message, "bad");
    }
  };
  $("showKey").onclick = () => {
    const f = $("apiKey");
    f.type = f.type === "password" ? "text" : "password";
    $("showKey").textContent = f.type === "password" ? "show" : "hide";
  };

  $("model").onchange = (e) => saveSettings({ model: e.target.value });
  $("scope").onchange = (e) => saveSettings({ scope: e.target.value });
  $("includePinned").onchange = (e) => saveSettings({ includePinned: e.target.checked });
  $("shortcuts").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  };
})();
