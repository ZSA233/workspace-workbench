import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function localPaseoEndpoint() {
  try {
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const record = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8"));
    const target = String(record.listen || record.sockPath || "").replace(/^unix:\/\//, "");
    if (target.startsWith("/")) return `ws+unix://${target}:/ws`;
    if (/^(127\.0\.0\.1|localhost):\d+$/.test(target)) return `ws://${target}/ws`;
  } catch {}
  return "";
}
