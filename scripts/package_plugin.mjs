#!/usr/bin/env node
/** Create the self-contained, source-based Paseo plugin archive. */

import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMetadata, readVersion } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  "client", "server", "shared", "backend", "scripts", "index.client.tsx", "index.server.ts",
  "mcp.mjs", "paseo-plugin.json", "tsconfig.json", "README.md", "package.json", "package-lock.json",
];

export async function buildArchive(base = root, outputDir = join(base, "dist")) {
  const errors = await checkMetadata(base);
  if (errors.length) throw new Error(`version metadata is inconsistent:\n${errors.join("\n")}`);
  await mkdir(outputDir, { recursive: true });
  const version = await readVersion(base);
  const archive = join(resolve(outputDir), `workspace-workbench-paseo-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", join(base, "paseo-plugin"), ...entries], { stdio: "inherit" });
  return archive;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const outputIndex = process.argv.indexOf("--output-dir");
  const outputDir = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : join(root, "dist");
  buildArchive(root, outputDir).then((archive) => console.log(archive)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
