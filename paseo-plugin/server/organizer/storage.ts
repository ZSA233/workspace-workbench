import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { modelProfileSchema, organizerPolicySchema, organizerPatchSchema, type ModelProfile, type OrganizerPolicy, type OrganizerTarget, type WorkspaceAnalysis, type ConversationAnalysis, type OrganizerRun, type OrganizerJob, type OrganizerModelTest } from '../../shared/organizer.ts';
import type { ProjectRoute } from '../projects.ts';

export const organizerHash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const organizerRoot = () => process.env.WORKBENCH_ORGANIZER_HOME || join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'workspace-workbench', 'organizer');
export function readOrganizerJson<T>(path: string, fallback: T): T {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('organizer_storage_invalid'); return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export function writeOrganizerJson(path: string, value: unknown) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw Error('organizer_storage_limit');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(tmp, data + '\n', { mode: 0o600 }); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
type Settings = { version: 1; revision: number; defaults: Partial<OrganizerPolicy>; projects: Record<string, Partial<OrganizerPolicy> & { enabledAt?: string }>; profiles: ModelProfile[]; [key: string]: unknown };
export class OrganizerSettings {
  readonly root: string;
  constructor(root = organizerRoot()) { this.root = root; }
  private file() { return join(this.root, 'settings.json'); }
  read(): Settings {
    const value = readOrganizerJson<Settings>(this.file(), { version: 1, revision: 0, defaults: {}, projects: {}, profiles: [] });
    if (value.version !== 1 || !Number.isInteger(value.revision)) throw Error('organizer_settings_invalid');
    return value;
  }
  response(project?: ProjectRoute) {
    const saved = this.read(), patch = project ? saved.projects[project.configPath] || {} : {};
    return { revision: saved.revision, defaults: saved.defaults, project: patch, effective: organizerPolicySchema.parse({ ...saved.defaults, ...patch }),
      profiles: saved.profiles.map(profile => ({ ...profile, hasSecret: existsSync(this.secretFile(profile.id)) })), enabledAt: patch.enabledAt || null };
  }
  save(scope: 'host' | 'project', revision: number, patch: Partial<OrganizerPolicy>, reset: string[], project?: ProjectRoute) {
    const saved = this.read(); if (saved.revision !== revision) throw Error('settings_revision_conflict');
    const fields = Object.keys(organizerPolicySchema.shape);
    if (reset.some(key => !fields.includes(key))) throw Error('organizer_reset_invalid');
    const parsed = organizerPatchSchema.parse(patch);
    if (scope === 'project' && !project) throw Error('project_context_required');
    if(scope==='project'&&(parsed.modelConcurrency!==undefined||reset.includes('modelConcurrency')))throw Error('organizer_concurrency_is_host_setting');
    const previous = scope === 'host' ? saved.defaults : saved.projects[project!.configPath] || {};
    const next: Partial<OrganizerPolicy> & { enabledAt?: string } = { ...previous, ...parsed };
    for (const key of reset) delete (next as Record<string, unknown>)[key];
    organizerPolicySchema.parse({ ...saved.defaults, ...next });
    if (scope === 'host') saved.defaults = next;
    else {
      const wasEnabled = organizerPolicySchema.parse({ ...saved.defaults, ...previous }).enabled;
      if (organizerPolicySchema.parse({...saved.defaults,...next}).enabled && !wasEnabled) next.enabledAt = new Date().toISOString();
      saved.projects[project!.configPath] = next;
    }
    // A host default enabled switch only enrolls future records, too.
    if (scope === 'host' && parsed.enabled === true && !previous.enabled) saved.enabledAt = new Date().toISOString();
    saved.revision++; writeOrganizerJson(this.file(), saved); return this.response(project);
  }
  enabledAt(project: ProjectRoute) {
    const s=this.read(),patch=s.projects[project.configPath];
    const at=patch?.enabled===true?patch.enabledAt||s.enabledAt:[patch?.enabledAt,s.enabledAt].filter(value=>typeof value==='string').sort().at(-1);
    return typeof at==='string'?at:'9999';
  }
  importLegacyBranches(project:ProjectRoute,values:Record<string,string>) {
    const saved=this.read(),patch=saved.projects[project.configPath]||{},previous=(patch as Record<string,unknown>).legacyProductionBranches as Record<string,string>|undefined;
    const incoming:Record<string,string>={};
    for(const [key,ref]of Object.entries(values)){let tuple:unknown;try{tuple=JSON.parse(key);}catch{continue;}if(Array.isArray(tuple)&&tuple[0]===project.configPath&&typeof tuple[1]==='string')incoming[tuple[1]]=ref;}
    if(organizerHash(previous||{})===organizerHash(incoming))return;
    const branches={...organizerPolicySchema.parse({...saved.defaults,...patch}).productionBranches};let changed=false;
    for(const [path,ref]of Object.entries(incoming))if(previous?.[path]!==ref&&branches[path]!==ref){branches[path]=ref;changed=true;}
    for(const [path,ref]of Object.entries(previous||{}))if(!(path in incoming)&&branches[path]===ref){delete branches[path];changed=true;}
    saved.projects[project.configPath]={...patch,...(changed?{productionBranches:branches}:{}),legacyProductionBranches:incoming} as typeof patch;
    if(changed)saved.revision++;
    writeOrganizerJson(this.file(),saved);
  }
  profile(id: string): ModelProfile { const found = this.read().profiles.find(profile => profile.id === id); if (!found) throw Error('organizer_model_required'); return modelProfileSchema.parse(found); }
  private secretFile(id: string) { return join(this.root, 'secrets', organizerHash(id)); }
  secret(id: string) {
    const file = this.secretFile(id);
    if (!existsSync(file)) return '';
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw Error('organizer_secret_permissions');
    return readFileSync(file, 'utf8').trim();
  }
  saveProfile(revision: number, value: ModelProfile, secret?: string) {
    const s = this.read(); if (s.revision !== revision) throw Error('settings_revision_conflict');
    const profile = modelProfileSchema.parse(value), url = new URL(profile.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('organizer_model_url_invalid');
    if (s.profiles.length >= 20 && !s.profiles.some(p => p.id === profile.id)) throw Error('organizer_profile_limit');
    if (secret !== undefined) {
      const file = this.secretFile(profile.id); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + randomUUID(); writeFileSync(tmp, secret, { mode: 0o600 }); renameSync(tmp, file);
    }
    s.profiles = [...s.profiles.filter(p => p.id !== profile.id), profile]; s.revision++; writeOrganizerJson(this.file(), s);
  }
  deleteProfile(revision: number, id: string) {
    const s = this.read(); if (s.revision !== revision) throw Error('settings_revision_conflict');
    s.profiles = s.profiles.filter(p => p.id !== id); s.revision++; writeOrganizerJson(this.file(), s);
    const secret = this.secretFile(id); if (existsSync(secret)) unlinkSync(secret);
  }
  fingerprint(project: ProjectRoute) { const s = this.response(project); return organizerHash([s.revision, s.effective]); }
}

export class OrganizerTestStore {
  private root:string;
  constructor(root:string){this.root=root;}
  private path(id:string){return join(this.root,'tests',organizerHash(id)+'.json');}
  list():OrganizerModelTest[]{return readOrganizerJson<OrganizerModelTest[]>(join(this.root,'tests','index.json'),[]);}
  create():OrganizerModelTest {
    const test:OrganizerModelTest={id:randomUUID(),state:'queued',createdAt:new Date().toISOString()},old=this.list();
    writeOrganizerJson(this.path(test.id),test);writeOrganizerJson(join(this.root,'tests','index.json'),[test,...old].slice(0,20));
    for(const stale of old.slice(19)){const path=this.path(stale.id);if(existsSync(path))unlinkSync(path);}
    return test;
  }
  get(id:string):OrganizerModelTest {if(!this.list().some(t=>t.id===id))throw Error('organizer_test_missing');return readOrganizerJson<OrganizerModelTest>(this.path(id),null as never);}
  update(id:string,patch:Partial<OrganizerModelTest>){const test={...this.get(id),...patch};writeOrganizerJson(this.path(id),test);writeOrganizerJson(join(this.root,'tests','index.json'),this.list().map(t=>t.id===id?{...test,run:undefined}:t));return test;}
  recover(){for(const t of this.list())if(t.state==='queued'||t.state==='running')this.update(t.id,{state:'interrupted',error:'插件已重载，测试未自动重放'});}
}

export type OrganizerLedger = { version: 1; revision: number; workspaces: Record<string, WorkspaceAnalysis>; targets: Record<string, OrganizerTarget>; conversations: Record<string, ConversationAnalysis>; jobs: OrganizerJob[]; runs: OrganizerRun[]; unlinked: string[]; refreshedAt?: string; error?: string; [key: string]: unknown };
export class OrganizerStore {
  readonly route: ProjectRoute;
  private hostIdentity: string;
  constructor(route: ProjectRoute, hostIdentity = organizerRoot()) { this.route = route; this.hostIdentity = organizerHash(hostIdentity).slice(0, 24); }
  private root() { return join(this.route.stateRoot, 'organizer', 'hosts', this.hostIdentity); }
  read(): OrganizerLedger {
    const value = readOrganizerJson<OrganizerLedger>(join(this.root(), 'ledger.json'), { version: 1, revision: 0, workspaces: {}, targets: {}, conversations: {}, jobs: [], runs: [], unlinked: [] });
    if (value.version !== 1 || !Number.isInteger(value.revision)) throw Error('organizer_ledger_invalid');
    return value;
  }
  update(edit: (ledger: OrganizerLedger) => void): OrganizerLedger {
    const ledger = this.read(); edit(ledger); ledger.revision++; ledger.jobs = ledger.jobs.slice(-40); ledger.runs = ledger.runs.slice(-30);
    writeOrganizerJson(join(this.root(), 'ledger.json'), ledger); return ledger;
  }
  addRun(run: OrganizerRun) {
    writeOrganizerJson(join(this.root(), 'runs', organizerHash(run.id) + '.json'), run);
    const old = this.read().runs;
    this.update(l => { l.runs.push({ ...run, input: '', prompt: '', output: undefined }); });
    for (const item of old.slice(0, Math.max(0, old.length - 29))) {
      const file = join(this.root(), 'runs', organizerHash(item.id) + '.json'); if (existsSync(file)) unlinkSync(file);
    }
  }
  run(id: string) {
    if (!this.read().runs.some(run => run.id === id)) throw Error('organizer_run_missing');
    return readOrganizerJson<OrganizerRun | null>(join(this.root(), 'runs', organizerHash(id) + '.json'), null);
  }
  recover() {
    const value = this.read();
    if (value.jobs.some(j => j.state === 'running' || j.state === 'queued')) this.update(l => { for (const j of l.jobs) if (j.state === 'running' || j.state === 'queued') { j.state = 'interrupted'; j.updatedAt = new Date().toISOString(); } });
  }
}
