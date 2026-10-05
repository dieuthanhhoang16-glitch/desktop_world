"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ROOT = path.join(os.homedir(), ".clawd", "reflections-v1");
const FIELDS = ["main", "result", "next", "learning"];
const MAX_TEXT = 500;
const MAX_CHECKS = 8;

function localDate(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")].join("-");
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year, month - 1, day + days);
  return localDate(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function cleanRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid reflection");
  const record = {};
  for (const field of FIELDS) {
    if (typeof value[field] !== "string" || value[field].length > MAX_TEXT) throw new TypeError(`invalid ${field}`);
    record[field] = value[field].trim();
  }
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) throw new TypeError("invalid checks");
  record.checks = value.checks.map((item) => {
    if (!item || typeof item.text !== "string" || item.text.length > MAX_TEXT
      || typeof item.done !== "boolean") throw new TypeError("invalid check");
    return { text: item.text.trim(), done: item.done };
  }).filter((item) => item.text);
  return record;
}

function emptyRecord() {
  return { main: "", result: "", next: "", learning: "", checks: [] };
}

function createReflectionStore(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  if (root === path.parse(root).root) throw new TypeError("invalid reflection root");
  const io = options.fs || fs;
  const clock = options.now || (() => new Date());
  function ensureRoot() {
    const parent = path.dirname(root);
    if (io.existsSync(parent) && io.lstatSync(parent).isSymbolicLink()) throw new Error("unsafe reflection parent");
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = io.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe reflection root");
    if (process.platform !== "win32") io.chmodSync(root, 0o700);
  }
  function file(date) {
    if (!validDate(date)) throw new TypeError("invalid reflection date");
    return path.join(root, `${date}.json`);
  }
  function existingFile(target) {
    try {
      const stat = io.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe reflection file");
      return stat;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  function read(date) {
    const target = file(date);
    ensureRoot();
    const stat = existingFile(target);
    if (!stat) return { date, ...emptyRecord() };
    if (stat.size > 8192) throw new Error("unsafe reflection file");
    const parsed = JSON.parse(io.readFileSync(target, "utf8"));
    if (parsed.version !== 1 || parsed.date !== date) throw new Error("invalid reflection file");
    return { date, ...cleanRecord(parsed) };
  }
  function save(date, value) {
    const target = file(date);
    const record = cleanRecord(value);
    ensureRoot();
    existingFile(target);
    const temporary = path.join(root, `.${date}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      io.writeFileSync(temporary, `${JSON.stringify({ version: 1, date, ...record })}\n`,
        { flag: "wx", mode: 0o600 });
      io.renameSync(temporary, target);
    } catch (error) {
      try { io.unlinkSync(temporary); } catch {}
      throw error;
    }
    return { date, ...record };
  }
  function query() {
    const today = localDate(clock());
    return {
      today,
      days: Array.from({ length: 7 }, (_, index) => read(shiftDate(today, -index))),
    };
  }
  function clear() {
    ensureRoot();
    let count = 0;
    for (const name of io.readdirSync(root)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name) || !validDate(name.slice(0, 10))) continue;
      const target = path.join(root, name);
      existingFile(target);
      io.unlinkSync(target);
      count++;
    }
    return count;
  }
  return { read, save, query, clear };
}

module.exports = { createReflectionStore, localDate, shiftDate, cleanRecord };
