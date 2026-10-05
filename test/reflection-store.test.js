"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createReflectionStore } = require("../src/reflection-store");

test("manual reflections survive restart and remain separate from footprint data", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reflection-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "reflections-v1");
  const now = () => new Date(2026, 9, 5, 12);
  const first = createReflectionStore({ root, now });
  assert.equal(first.query().days[0].date, "2026-10-05");
  first.save("2026-10-04", { main: "Fix approval flow", result: "Tests passed",
    next: "Review edge cases", learning: "Why the hook waits", checks: [{ text: "Windows path", done: false }] });
  const second = createReflectionStore({ root, now });
  assert.equal(second.query().days[1].main, "Fix approval flow");
  assert.equal(second.query().days[1].checks[0].done, false);
  assert.equal(fs.statSync(path.join(root, "2026-10-04.json")).mode & 0o777, 0o600);
  assert.equal(second.clear(), 1);
  assert.equal(second.query().days[1].main, "");
});

test("rejects malformed dates, oversized content, and linked records", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reflection-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = createReflectionStore({ root: path.join(base, "reflections") });
  const record = { main: "", result: "", next: "", learning: "", checks: [] };
  assert.throws(() => store.save("../x", record));
  assert.throws(() => store.save("2026-02-30", record));
  assert.throws(() => store.save("2026-10-05", { ...record, main: "x".repeat(501) }));
  fs.mkdirSync(path.join(base, "reflections"));
  fs.symlinkSync(path.join(base, "outside"), path.join(base, "reflections", "2026-10-05.json"));
  assert.throws(() => store.save("2026-10-05", record));
  assert.throws(() => store.read("2026-10-05"));
});
