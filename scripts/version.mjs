#!/usr/bin/env node
/** Validate and update the coordinated Node/Paseo version metadata. */

import { readFile, writeFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packagePath = (base) => join(base, "paseo-plugin", "package.json");
const lockPath = (base) => join(base, "paseo-plugin", "package-lock.json");

export class VersionError extends Error {}

export function parseVersion(value) {
  const text = String(value ?? "").trim();
  if (!versionPattern.test(text)) throw new VersionError(`invalid SemVer (expected MAJOR.MINOR.PATCH): ${JSON.stringify(text)}`);
  return text.split(".").map(Number);
}

export async function readVersion(base = root) {
  const path = join(base, "VERSION");
  let value;
  try { value = (await readFile(path, "utf8")).trim(); }
  catch (error) { throw new VersionError(`missing ${path}: ${error.message}`); }
  parseVersion(value);
  return value;
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value;
  } catch (error) { throw new VersionError(`cannot read JSON metadata ${path}: ${error.message}`); }
}

export async function checkMetadata(base = root, tag = null) {
  const errors = [];
  let version;
  try { version = await readVersion(base); }
  catch (error) { return [error.message]; }
  if (tag !== null && tag !== `v${version}`) errors.push(`release tag ${JSON.stringify(tag)} does not match v${version}`);
  const packageFile = packagePath(base);
  const lockFile = lockPath(base);
  let pkg;
  let lock;
  try { pkg = await readJson(packageFile); lock = await readJson(lockFile); }
  catch (error) { errors.push(error.message); return errors; }
  if (pkg.name !== "workspace-workbench-paseo") errors.push(`${packageFile}: unexpected package name ${JSON.stringify(pkg.name)}`);
  if (pkg.version !== version) errors.push(`${packageFile}: version ${JSON.stringify(pkg.version)} does not match ${version}`);
  if (lock.name !== pkg.name) errors.push(`${lockFile}: root package name does not match ${packageFile}`);
  if (lock.version !== version) errors.push(`${lockFile}: top-level version ${JSON.stringify(lock.version)} does not match ${version}`);
  const packageRoot = lock.packages && typeof lock.packages === "object" ? lock.packages[""] : null;
  if (!packageRoot || typeof packageRoot !== "object") errors.push(`${lockFile}: missing packages root entry`);
  else if (packageRoot.version !== version) errors.push(`${lockFile}: packages root version ${JSON.stringify(packageRoot.version)} does not match ${version}`);
  return errors;
}

async function atomicWrite(path, content) {
  const mode = existsSync(path) ? (await stat(path)).mode & 0o777 : 0o644;
  const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

export function bumpedVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new VersionError(`unknown bump level: ${level}`);
}

export async function setVersion(base = root, target) {
  parseVersion(target);
  const errors = await checkMetadata(base);
  if (errors.length) throw new VersionError(`cannot update inconsistent metadata:\n${errors.join("\n")}`);
  const current = await readVersion(base);
  const packageFile = packagePath(base);
  const lockFile = lockPath(base);
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  pkg.version = target;
  lock.version = target;
  if (lock.packages?.[""]) lock.packages[""].version = target;
  await atomicWrite(join(base, "VERSION"), `${target}\n`);
  await atomicWrite(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  await atomicWrite(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
}

async function main(argv) {
  const args = [...argv];
  const rootIndex = args.indexOf("--root");
  const base = rootIndex >= 0 ? resolve(args.splice(rootIndex, 2)[1]) : root;
  if (args.includes("--check")) {
    const tagIndex = args.indexOf("--tag");
    const tag = tagIndex >= 0 ? args[tagIndex + 1] : null;
    const errors = await checkMetadata(base, tag);
    if (errors.length) { for (const error of errors) console.error(`version check failed: ${error}`); process.exitCode = 1; return; }
    console.log(`version metadata is consistent: ${await readVersion(base)}`);
    return;
  }
  const setIndex = args.indexOf("--set");
  const bumpIndex = args.indexOf("--bump");
  if (setIndex < 0 && bumpIndex < 0) throw new VersionError("one of --check, --set, or --bump is required");
  if (setIndex >= 0 && bumpIndex >= 0) throw new VersionError("--set and --bump are mutually exclusive");
  const current = await readVersion(base);
  const target = setIndex >= 0 ? args[setIndex + 1] : bumpedVersion(current, args[bumpIndex + 1]);
  await setVersion(base, target);
  console.log(`updated version to ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { console.error(`version update failed: ${error.message}`); process.exitCode = 1; });
}
