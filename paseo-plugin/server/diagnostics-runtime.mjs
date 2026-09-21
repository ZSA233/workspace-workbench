import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_EVENTS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_COMPONENT = 2;
const MAX_PENDING = 256;

function safe(value, depth = 0) {
  if (depth > 3) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 1000)
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)[^\s,]+/gi, "$1[redacted]");
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safe(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/token|authorization|secret|password|credential|content|body|prompt/i.test(key)) continue;
      out[key] = safe(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

async function trimFile(path) {
  try {
    const info = await stat(path);
    if (info.size <= MAX_BYTES) return;
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean).slice(-MAX_EVENTS);
    await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  } catch {}
}

async function pruneComponentFiles(root, component, currentFile) {
  try {
    const entries = await Promise.all((await readdir(root))
      .filter(name => name.startsWith(`${component}.`) && name.endsWith(".jsonl"))
      .map(async name => {
        const path = join(root, name);
        try { return { path, mtime: (await stat(path)).mtimeMs }; } catch { return null; }
      }));
    const files = entries.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const keep = new Set(files.slice(0, MAX_FILES_PER_COMPONENT).map(item => item.path));
    keep.add(currentFile);
    await Promise.all(files.filter(item => !keep.has(item.path)).map(item => rm(item.path, { force: true }).catch(() => {})));
  } catch {}
}

export function createDiagnosticSink({ root, component, pid = process.pid, generation = "unknown" }) {
  const file = join(root, `${component}.${pid}.jsonl`);
  void mkdir(root, { recursive: true }).then(() => pruneComponentFiles(root, component, file));
  let closed = false;
  let dropped = 0;
  let draining = false;
  const pending = [];
  const write = async event => {
    try {
      await mkdir(root, { recursive: true });
      await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
      await trimFile(file);
    } catch {
      dropped++;
    }
  };
  const important = event => /failed|timeout|cancel|reject|shutdown|exit|parent_missing|cleanup/i.test(String(event.event || "")) || Boolean(event.errorCode);
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) await write(pending.shift());
    } finally {
      draining = false;
      if (pending.length && !closed) void drain();
    }
  };
  const record = (event, extra = {}) => {
    if (closed) return;
    const payload = safe({
      at: new Date().toISOString(),
      pluginGeneration: generation,
      component,
      pid,
      parentPid: process.ppid,
      ...event,
      ...extra,
    });
    if (pending.length >= MAX_PENDING) {
      const ordinary = pending.findIndex(item => !important(item));
      if (ordinary >= 0) pending.splice(ordinary, 1);
      else { dropped++; return; }
      dropped++;
    }
    pending.push(payload);
    void drain();
    console.error("workbench_diagnostic", JSON.stringify(payload));
  };
  return {
    file,
    record,
    status: () => ({ file, dropped, queued: pending.length, draining }),
    async close() {
      closed = true;
      while (pending.length) await write(pending.shift());
    },
  };
}

export async function readDiagnosticEvents(root, limit = 200) {
  try { await mkdir(root, { recursive: true }); } catch {}
  let names = [];
  try { names = (await readdir(root)).filter(name => name.endsWith(".jsonl")); } catch { return []; }
  const events = [];
  for (const name of names) {
    try {
      const lines = (await readFile(join(root, name), "utf8")).split("\n").filter(Boolean).slice(-MAX_EVENTS);
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
  return events.sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).slice(-Math.max(1, Math.min(1000, limit)));
}

export { MAX_EVENTS, MAX_BYTES };
