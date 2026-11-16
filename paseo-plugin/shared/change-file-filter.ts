/** Presentation only: these rules never change a Git comparison or review scope. */
export type TestFileDisplay = 'all' | 'dim' | 'hide';
export type NoteFilter = 'all' | 'has' | 'none' | 'pending' | 'stale';
export type PathFilter = { include: string; exclude: string; matchMode: 'text' | 'glob' };
export type TestFileRules = { disabledPresets: string[]; testPatterns: string[]; normalPatterns: string[] };
export type TestFilePreset = { id: string; label: string; labelZh: string; patterns: readonly string[] };
export type FileClassification = { test: boolean; source?: 'preset' | 'project-test' | 'project-normal'; pattern?: string; presetId?: string };
export type FilterableFile = { path: string; oldPath?: string | null };
export const DEFAULT_TEST_RULES: TestFileRules = { disabledPresets: [], testPatterns: [], normalPatterns: [] };
export const DEFAULT_PATH_FILTER: PathFilter = { include: '', exclude: '', matchMode: 'text' };
const MAX_PATTERN_LENGTH = 512;

/** Segment wildcard matching has bounded work and does not execute user regular expressions. */
function segmentMatches(pattern: string, name: string): boolean {
  let p = 0, n = 0, star = -1, retry = 0;
  while (n < name.length) {
    if (pattern[p] === '?' || pattern[p] === name[n]) { p++; n++; }
    else if (pattern[p] === '*') { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function compilePathPattern(input: string): (path: string) => boolean {
  const pattern = input.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || /[\0\r\n]/.test(pattern) || pattern.startsWith('/')) throw new Error('invalid_path_pattern');
  const parts = pattern.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('**') && part !== '**')) throw new Error('invalid_path_pattern');
  if (parts.length === 1 && parts[0] !== '**') return path => segmentMatches(pattern, path.split('/').at(-1) || '');
  return path => {
    const names = path.replace(/^\.\//, '').split('/');
    let prior = new Array<boolean>(names.length + 1).fill(false); prior[0] = true;
    for (const part of parts) {
      const next = new Array<boolean>(names.length + 1).fill(false);
      if (part === '**') {
        next[0] = prior[0];
        for (let i = 1; i <= names.length; i++) next[i] = prior[i] || next[i - 1];
      } else for (let i = 1; i <= names.length; i++) next[i] = prior[i - 1] && segmentMatches(part, names[i - 1]);
      prior = next;
    }
    return prior[names.length];
  };
}

export function validateTestRules(rules: TestFileRules): void {
  for (const patterns of [rules.testPatterns, rules.normalPatterns]) {
    if (patterns.length > 128) throw new Error('too_many_path_patterns');
    patterns.forEach(compilePathPattern);
  }
}

const presets = new Map<string, TestFilePreset>();
export function registerTestFilePreset(preset: TestFilePreset): () => void {
  if (presets.has(preset.id)) throw new Error('duplicate_test_preset');
  preset.patterns.forEach(compilePathPattern);
  presets.set(preset.id, preset);
  return () => { if (presets.get(preset.id) === preset) presets.delete(preset.id); };
}
export function testFilePresets(): readonly TestFilePreset[] { return [...presets.values()]; }
registerTestFilePreset({ id: 'go', label: 'Go', labelZh: 'Go', patterns: ['*_test.go'] });
registerTestFilePreset({ id: 'python', label: 'Python', labelZh: 'Python', patterns: ['test_*.py', '*_test.py'] });
const scriptExtensions = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];
registerTestFilePreset({ id: 'javascript', label: 'JavaScript / TypeScript', labelZh: 'JavaScript / TypeScript', patterns: scriptExtensions.flatMap(ext => [`*.test.${ext}`, `*.spec.${ext}`, `**/__tests__/**/*.${ext}`]) });
registerTestFilePreset({ id: 'jvm', label: 'Java / Kotlin', labelZh: 'Java / Kotlin', patterns: ['java', 'kt'].flatMap(ext => [`**/src/test/**/*.${ext}`, `**/src/androidTest/**/*.${ext}`]) });

export function createFileClassifier(rules: TestFileRules = DEFAULT_TEST_RULES): (path: string) => FileClassification {
  validateTestRules(rules);
  const normal = rules.normalPatterns.map(pattern => ({ pattern, match: compilePathPattern(pattern) }));
  const custom = rules.testPatterns.map(pattern => ({ pattern, match: compilePathPattern(pattern) }));
  const builtIn = [...presets.values()].filter(p => !rules.disabledPresets.includes(p.id)).flatMap(p => p.patterns.map(pattern => ({ pattern, presetId: p.id, match: compilePathPattern(pattern) })));
  return path => {
    const exception = normal.find(rule => rule.match(path));
    if (exception) return { test: false, source: 'project-normal', pattern: exception.pattern };
    const override = custom.find(rule => rule.match(path));
    if (override) return { test: true, source: 'project-test', pattern: override.pattern };
    // Associated assets are not assumed to be test source. Project rules can opt them in.
    if (/(^|\/)(?:testdata|fixtures|__fixtures__|snapshots|__snapshots__|examples)(\/|$)/.test(path)) return { test: false };
    const matched = builtIn.find(rule => rule.match(path));
    return matched ? { test: true, source: 'preset', presetId: matched.presetId, pattern: matched.pattern } : { test: false };
  };
}

export function pathFilterMatcher(filter: PathFilter): (file: FilterableFile) => boolean {
  const include = filter.include.trim(), exclude = filter.exclude.trim();
  const matcher = (pattern: string) => filter.matchMode === 'glob' ? compilePathPattern(pattern) : (path: string) => path.toLowerCase().includes(pattern.toLowerCase());
  const included = include ? matcher(include) : undefined, excluded = exclude ? matcher(exclude) : undefined;
  return file => {
    const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
    return (!included || paths.some(included)) && (!excluded || !paths.some(excluded));
  };
}

export function filterChangedFiles<T extends FilterableFile>(files: readonly T[], filter: PathFilter, display: TestFileDisplay, classify: (path: string) => FileClassification, noteMatches: (path: string) => boolean = () => true) {
  const matches = pathFilterMatcher(filter), classifications = new Map<string, FileClassification>(), visible: T[] = [];
  let hiddenTests = 0;
  for (const file of files) {
    const classification = classify(file.path); classifications.set(file.path, classification);
    if (!matches(file) || !noteMatches(file.path)) continue;
    if (display === 'hide' && classification.test) hiddenTests++;
    else visible.push(file);
  }
  return { files: visible, classifications, hiddenTests, total: files.length };
}

/** Preserve an existing path, otherwise prefer the next visible path in original order. */
export function nextVisibleFile(allPaths: readonly string[], visiblePaths: readonly string[], current: string): string {
  const visible = new Set(visiblePaths);
  if (visible.has(current)) return current;
  const index = allPaths.indexOf(current);
  for (let i = Math.max(0, index + 1); i < allPaths.length; i++) if (visible.has(allPaths[i])) return allPaths[i];
  for (let i = index - 1; i >= 0; i--) if (visible.has(allPaths[i])) return allPaths[i];
  return visiblePaths[0] || '';
}
