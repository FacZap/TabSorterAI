import assert from "node:assert/strict";
import { validatePlan, tabLabel, isOrganizable, toMarkdown } from "../plan.js";

const flat = (groups) => groups.flatMap((g) => g.tabs).sort((a, b) => a - b);

// Duplicates, out-of-range and non-integer indices are dropped; missing go to Other.
{
  const g = validatePlan({
    groups: [
      { name: "Work", color: "blue", tabs: [0, 1, 1, 9, -1, 2.5] },
      { name: "Fun", color: "magenta", tabs: [1, 2] },
      { name: "Empty", color: "red", tabs: [7] },
    ],
  }, 5);
  assert.deepEqual(g.map((x) => x.name), ["Work", "Fun", "Other"]);
  assert.deepEqual(g[0].tabs, [0, 1]);
  assert.deepEqual(g[1].tabs, [2]);
  assert.equal(g[1].color, "blue"); // invalid color replaced by the palette
  assert.deepEqual(g[2].tabs, [3, 4]);
  assert.deepEqual(flat(g), [0, 1, 2, 3, 4]);
}

// Leftovers join an existing "Other" group rather than making a second one.
{
  const g = validatePlan({ groups: [{ name: "other", color: "grey", tabs: [0] }] }, 3);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].tabs, [0, 1, 2]);
}

// Garbage input still covers every tab.
{
  assert.deepEqual(flat(validatePlan(null, 3)), [0, 1, 2]);
  assert.deepEqual(flat(validatePlan({ groups: "nope" }, 2)), [0, 1]);
  assert.deepEqual(validatePlan({ groups: [] }, 0), []);
}

// Blank names get a placeholder.
{
  const g = validatePlan({ groups: [{ name: "  ", color: "red", tabs: [0] }] }, 1);
  assert.equal(g[0].name, "Group 1");
}

// Existing-group references: valid ones kept, out-of-range, non-integer and
// second uses of the same group become new groups (-1).
{
  const g = validatePlan({
    groups: [
      { name: "A", color: "red", tabs: [0], existing: 1 },
      { name: "B", color: "blue", tabs: [1], existing: 1 },
      { name: "C", color: "green", tabs: [2], existing: 5 },
      { name: "D", color: "pink", tabs: [3], existing: 0.5 },
      { name: "E", color: "cyan", tabs: [4] },
    ],
  }, 6, 2);
  assert.deepEqual(g.map((x) => x.existing), [1, -1, -1, -1, -1, -1]);
  assert.equal(g[5].name, "Other");
  // Without existing groups every reference is dropped.
  assert.equal(validatePlan({ groups: [{ name: "A", color: "red", tabs: [0], existing: 0 }] }, 1)[0].existing, -1);
}

assert.equal(tabLabel("https://github.com/foo/bar/?q=1#x"), "github.com/foo/bar");
assert.equal(tabLabel("not a url"), "not a url");

assert.equal(isOrganizable({ url: "https://a.com", pinned: false }, false), true);
assert.equal(isOrganizable({ url: "https://a.com", pinned: true }, false), false);
assert.equal(isOrganizable({ url: "https://a.com", pinned: true }, true), true);
assert.equal(isOrganizable({ url: "chrome://settings", pinned: false }, true), false);

const md = toMarkdown({
  title: "T", date: 0, overview: "O", key_points: ["k"],
  tabs: [{ title: "A [b]", url: "https://a.com", summary: "s" }],
});
assert.match(md, /^## T/);
assert.match(md, /- \[A b\]\(https:\/\/a\.com\) — s/);

console.log("plan.js: all tests passed");
