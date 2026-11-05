// Shared settings. Everything lives in chrome.storage.local (never sync): the
// API key must not be copied to Google's servers along with the profile.

export const DEFAULTS = {
  apiKey: "",
  model: "claude-haiku-4-5",
  scope: "all",          // "all" windows or the popup's "window"
  includePinned: false,
  deep: false,           // read page text for summaries (needs <all_urls>)
  applyMode: "groups",   // "groups" in one window, or "windows" one per group
  keepGroups: true,      // leave tabs already in a group where they are; only sort the rest
};

export const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fast, cheap)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (balanced)" },
  { id: "claude-opus-5", label: "Claude Opus 5 (best grouping)" },
];

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
