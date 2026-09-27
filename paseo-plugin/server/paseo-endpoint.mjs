import { normalizePaseoEndpoint } from "../shared/paseo-endpoint.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function localPaseoEndpoint() {
  try {
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const record = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8"));
    return normalizePaseoEndpoint(record.listen || record.sockPath || '');
  } catch {}
  return "";
}

