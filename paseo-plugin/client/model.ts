export type WorkspaceFilter = "all" | "attention" | "dirty" | "unpushed" | "history";
export type ChangeScope = "branch" | "working" | "commit";
export type ObserverSectionId = "repositories" | "graph" | "changes";

export type SectionLayoutPreference = {
  collapsed: boolean;
  /** Explicit viewport height; null means content-aware automatic height. */
  height: number | null;
};

export type ObserverSectionLayout = Record<ObserverSectionId, SectionLayoutPreference>;

const sectionIds: ObserverSectionId[] = ["repositories", "graph", "changes"];
const sectionAutoMaxHeights: Record<ObserverSectionId, number> = {
  repositories: 220,
  graph: 280,
  changes: 600,
};
export const MIN_SECTION_HEIGHT = 72;
const MAX_SECTION_HEIGHT = 600;

export function defaultObserverSectionLayout(): ObserverSectionLayout {
  return {
    repositories: { collapsed: false, height: null },
    graph: { collapsed: false, height: null },
    changes: { collapsed: false, height: null },
  };
}

export function normalizeObserverSectionLayout(
  value: Partial<Record<ObserverSectionId, Partial<SectionLayoutPreference>>> | null | undefined,
): ObserverSectionLayout {
  const defaults = defaultObserverSectionLayout();
  for (const id of sectionIds) {
    const item = value?.[id];
    if (!item) continue;
    defaults[id] = {
      collapsed: item.collapsed === true,
      height: typeof item.height === "number" && Number.isFinite(item.height)
        ? Math.round(item.height)
        : null,
    };
  }
  return defaults;
}

export function sectionAutoMaxHeight(id: ObserverSectionId, availableHeight: number, fillAvailable = false): number {
  const availableLimit = availableHeight > 0
    ? fillAvailable
      ? Math.floor(availableHeight)
      : Math.max(180, Math.floor(availableHeight * 0.8))
    : MAX_SECTION_HEIGHT;
  return Math.max(MIN_SECTION_HEIGHT, Math.min(sectionAutoMaxHeights[id], MAX_SECTION_HEIGHT, availableLimit));
}

export function clampSectionHeight(height: number | null | undefined, availableHeight: number, fillAvailable = false): number | null {
  if (height === null || height === undefined || !Number.isFinite(height)) return null;
  const availableLimit = availableHeight > 0
    ? fillAvailable
      ? Math.floor(availableHeight)
      : Math.max(180, Math.floor(availableHeight * 0.8))
    : MAX_SECTION_HEIGHT;
  const maximum = Math.max(MIN_SECTION_HEIGHT, Math.min(MAX_SECTION_HEIGHT, availableLimit));
  return Math.min(maximum, Math.max(MIN_SECTION_HEIGHT, Math.round(height)));
}

export function sectionRemainingHeight(availableHeight: number, occupiedHeight: number, bottomPadding = 0): number {
  if (availableHeight <= 0) return availableHeight;
  return Math.max(
    MIN_SECTION_HEIGHT,
    Math.floor(availableHeight - Math.max(0, occupiedHeight) - Math.max(0, bottomPadding)),
  );
}

export type ToolchainRequirementSummary = {
  requested: string[];
  resolved: string[];
};

export type ToolchainRepositorySummary = {
  status: string;
  tools: string[];
  issues: Issue[];
  sources?: Record<string, string>;
  binPaths?: string[];
};

export type ToolchainSummary = {
  manager: string;
  mode?: "auto" | "system" | "mise" | string;
  status: string;
  managerAvailable?: boolean;
  managerPath?: string | null;
  cache?: { scope?: string; root?: string; enabled?: boolean };
  requirements: Record<string, ToolchainRequirementSummary>;
  preparedRepositories: Record<string, ToolchainRepositorySummary>;
  issues: Issue[];
  environment?: { pathEntries?: string[]; variables?: Record<string, string> };
  generatedAt?: string | null;
};

export type WorkspaceTask = {
  kind?: string;
  id?: string;
  label?: string;
  status?: string;
};

export type WorkspaceDeletion = {
  requestedAt?: string;
  blocksNewTasks?: boolean;
  activeTasks?: WorkspaceTask[];
};

export type WorkspaceDeletionImpact = {
  workspaceId: string;
  preview: boolean;
  irreversible: boolean;
  canDelete?: boolean;
  repositories?: Array<{
    id?: string;
    repoPath?: string;
    branch?: string | null;
    worktreePath?: string | null;
    worktreeExists?: boolean;
    dirty?: boolean;
    dirtyPaths?: string[];
    branchPreserved?: boolean;
  }>;
  dirtyRepositories?: number;
  externalReferences?: Array<{ repository?: string; ref?: string }>;
  branchesPreserved?: string[];
  preserves?: string[];
  loses?: string[];
  runtimeState?: {
    agentBinding?: boolean;
    reviewSessionCount?: number;
    activeReviewSessionId?: string | null;
  };
};

export type ObservationMeta = {
  state: "ready" | "partial" | "timeout" | "busy" | string;
  observedAt?: string;
  durationMs?: number;
  queueMs?: number;
  issues?: Issue[];
  cacheState?: "fresh" | "stale" | "refreshing" | "degraded" | string;
  cacheAgeMs?: number;
  deferred?: boolean;
  lastObservedAt?: string;
  lastSuccessfulAt?: string;
  refreshing?: boolean;
};

export type WorkspaceSummary = {
  id: string;
  displayName?: string;
  kind?: "managed" | "live";
  managed?: boolean;
  sourceRoot?: string;
  treePath?: string;
  description: string;
  state: string;
  createdAt?: string | null;
  lastUsedAt?: string | null;
  updatedAt?: string | null;
  observedAt?: string | null;
  deletion?: WorkspaceDeletion | null;
  repositoryCount: number;
  dirtyRepositoryCount: number | null;
  dirty: boolean | null;
  unpushed: boolean | null;
  attentionReasons?: string[];
  claim: { agent?: string; owner?: string; label?: string } | null;
  blockerCount: number;
  issues?: Issue[];
  toolchain?: ToolchainSummary;
  observationStale?: boolean;
};

export type WorkspaceSelectionResolution = {
  workspaceId: string;
  source: "current" | "saved" | "identified" | "first";
};

export function resolveWorkspaceSelection(input: {
  currentWorkspaceId?: string;
  savedWorkspaceId?: string;
  identifiedWorkspaceId?: string | null;
  workspaces: readonly WorkspaceSummary[];
}): WorkspaceSelectionResolution | null {
  const selectable = input.workspaces.filter((workspace) => workspace.state !== "removed");
  const ids = new Set(selectable.map((workspace) => workspace.id));
  if (input.currentWorkspaceId && ids.has(input.currentWorkspaceId)) {
    return { workspaceId: input.currentWorkspaceId, source: "current" };
  }
  if (input.savedWorkspaceId && ids.has(input.savedWorkspaceId)) {
    return { workspaceId: input.savedWorkspaceId, source: "saved" };
  }
  if (input.identifiedWorkspaceId && ids.has(input.identifiedWorkspaceId)) {
    return { workspaceId: input.identifiedWorkspaceId, source: "identified" };
  }
  const first = selectable[0];
  return first ? { workspaceId: first.id, source: "first" } : null;
}

export type RepositorySummary = {
  name: string;
  repoPath: string;
  status: string;
  branch: string;
  head?: string;
  headShort: string;
  baseRef: string;
  baseSha?: string;
  baseShaShort: string;
  dirty: boolean;
  dirtyPaths: string[];
  ahead: number | null;
  behind: number | null;
  pushed: boolean | null;
  upstream?: string;
  branchScopeAvailable?: boolean;
  changes: ChangeSummary;
  workingChanges: ChangeSummary;
  issues: Issue[];
  changeIssues: Issue[];
  changesLoaded?: boolean;
  observationStale?: boolean;
};

export type ChangeSummary = {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
};

export type Issue = {
  code: string;
  message: string;
  path?: string;
};

export type ObservationResponseState = "ready" | "partial" | "timeout" | "busy" | "error";

export type ObserverResponseLike = {
  ok: boolean;
  result?: unknown;
  error?: { code?: string };
};

const transientIssueCodes = new Set([
  "git_timeout",
  "observation_timeout",
  "observer_timeout",
  "observer_busy",
  "observer_unavailable",
  "observer_connection_refused",
  "observer_socket_error",
  "git_diff_failed",
  "git_log_failed",
]);

const issueLabelKeys: Record<string, keyof WorkbenchCopy> = {
  worktree_missing: "text_db427e2fe9",
  record_invalid: "text_e0ea8945c4",
  path_invalid: "text_ec1e4a1e10",
  file_not_changed: "text_8c9ee7d66a",
  commit_missing: "text_e7404b46f4",
  base_missing: "text_f3ec0129e4",
  component_missing: "text_2f51f7e68d",
  detached_edit_worktree: "text_caa94a3fdf",
};

export function responseObservationState(
  response: ObserverResponseLike | undefined,
): ObservationResponseState | null {
  if (!response) return null;
  if (!response.ok) {
    if (response.error?.code === "observer_busy") return "busy";
    if (response.error?.code === "observer_timeout") return "timeout";
    return "error";
  }
  const result = response.result;
  const observation = result && typeof result === "object"
    ? (result as { observation?: { state?: unknown } }).observation
    : undefined;
  const resultIssues = result && typeof result === "object"
    ? (result as { issues?: unknown }).issues
    : undefined;
  if (!observation && Array.isArray(resultIssues) && resultIssues.length > 0) {
    const hasTransientIssue = resultIssues.some(
      (issue) => issue && typeof issue === "object" && isTransientIssueCode(String((issue as { code?: unknown }).code || "")),
    );
    return hasTransientIssue ? "partial" : "error";
  }
  const state = typeof observation?.state === "string" ? observation.state : "ready";
  if (state === "ready") return "ready";
  if (state === "timeout") return "timeout";
  if (state === "partial") return "partial";
  if (state === "busy") return "busy";
  return "partial";
}

export function isTransientIssueCode(code: string): boolean {
  return transientIssueCodes.has(code);
}

export function hasTransientIssues(issues: readonly Issue[]): boolean {
  return issues.some((issue) => isTransientIssueCode(issue.code));
}

export function issueDisplayLabel(code: string, strings: WorkbenchCopy = copy): string {
  return issueLabelKeys[code] ? strings[issueLabelKeys[code]] : strings.text_6b9afea9f1;
}

export type FileChange = {
  path: string;
  oldPath?: string | null;
  status: string;
  statusLabel: string;
  additions: number | null;
  deletions: number | null;
  worktreeOnly?: boolean;
  binary?: boolean;
  truncated?: boolean;
  missing?: boolean;
};

export type CommitNode = {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string | null;
  decorations: string[];
  isBase: boolean;
  refs?: GraphRef[];
  mergeSources?: GraphMergeSource[];
};

export type GraphRef = {
  name: string;
  shortName: string;
  kind: "local" | "remote" | "tag" | string;
  sha: string;
  isHead?: boolean;
  isUpstream?: boolean;
};

export type GraphMergeSource = {
  parentSha: string;
  refs?: GraphRef[];
};

export type DetailResult = {
  workspace: WorkspaceSummary;
  repositories: RepositorySummary[];
  observedAt?: string;
  observation?: ObservationMeta;
  observationStale?: boolean;
};

export type ListResult = {
  capabilities?: { create?: boolean; prepare?: boolean; cleanup?: boolean; remove?: boolean; restore?: boolean; permanentDelete?: boolean; agent?: boolean };
  workspaces: WorkspaceSummary[];
  observedAt?: string;
  observation?: ObservationMeta;
};

export type GraphResult = {
  nodes: CommitNode[];
  branch: string;
  head: string;
  baseSha: string;
  truncated?: boolean;
  historyMode?: "branch" | "full" | string;
  hasOlder?: boolean;
  loadedCount?: number;
  baseLoaded?: boolean;
  refs?: GraphRef[];
  refsFingerprint?: string;
};

export type ChangesResult = {
  files: FileChange[];
  summary: ChangeSummary;
  issues: Issue[];
  scope: ChangeScope;
  baseSha?: string;
  head?: string;
};

export type DiffResult = {
  path: string;
  oldPath?: string | null;
  scope: string;
  patch: string;
  truncated: boolean;
  binary?: boolean;
  status?: string;
  statusLabel?: string;
  baseSha?: string | null;
  head?: string | null;
};

export type ReviewEntry = {
  workspaceId: string;
  repoPath: string;
  branch: string;
  headShort: string;
  targetBranch: string;
  targetHeadShort: string;
  relation: string;
  dirty: boolean;
  unpushed: boolean;
  commitCount: number | null;
  changes: ChangeSummary;
  issues: Issue[];
};

export type ReviewRepository = {
  repoPath: string;
  entries: ReviewEntry[];
  overlaps: { path: string; workspaceIds: string[] }[];
  aggregate: { commits: number; files: number; additions: number; deletions: number };
  status: string;
  requiresReview: boolean;
};

export type ReviewResult = {
  workspaceIds: string[];
  repositories: ReviewRepository[];
  overlaps: { repoPath: string; path: string; workspaceIds: string[] }[];
  testEvidence: unknown;
  brief?: { text: string; byRepository: Record<string, string> };
};

export function mergePartialDetail(previous: DetailResult, next: DetailResult): DetailResult {
  const previousRepositories = new Map(
    previous.repositories.map((repository) => [repository.repoPath, repository]),
  );
  let hasStaleRepository = false;
  const repositories = next.repositories.map((repository) => {
    const issues = [...repository.issues, ...repository.changeIssues];
    if (!hasTransientIssues(issues)) {
      return { ...repository, observationStale: false };
    }
    hasStaleRepository = true;
    const previousRepository = previousRepositories.get(repository.repoPath);
    if (!previousRepository) return { ...repository, observationStale: true };
    return {
      ...previousRepository,
      issues: repository.issues,
      changeIssues: repository.changeIssues,
      observationStale: true,
    };
  });
  return {
    ...next,
    workspace: { ...next.workspace, observationStale: hasStaleRepository },
    repositories,
    observationStale: hasStaleRepository,
  };
}

export type TreeRow =
  | {
      kind: "directory";
      path: string;
      label: string;
      depth: number;
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | { kind: "file"; file: FileChange; depth: number };

type MutableTreeDirectory = {
  kind: "directory";
  path: string;
  label: string;
  directories: Map<string, MutableTreeDirectory>;
  files: FileChange[];
};

function timestampValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activityTimestamp(workspace: WorkspaceSummary): number | null {
  return (
    timestampValue(workspace.lastUsedAt) ??
    timestampValue(workspace.updatedAt) ??
    timestampValue(workspace.createdAt)
  );
}

export function sortWorkspaces(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) => {
    const leftMain = left.kind === "live" || left.managed === false;
    const rightMain = right.kind === "live" || right.managed === false;
    if (leftMain !== rightMain) return leftMain ? -1 : 1;
    const leftTime = activityTimestamp(left);
    const rightTime = activityTimestamp(right);
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.id.localeCompare(right.id);
  });
}

export function matchesWorkspaceFilter(
  workspace: WorkspaceSummary,
  filter: WorkspaceFilter,
): boolean {
  if (filter === "history") return workspace.state === "removed";
  if (workspace.state === "removed") return false;
  if (filter === "all") return true;
  if (filter === "dirty") return workspace.dirty === true;
  if (filter === "unpushed") return workspace.unpushed === true;
  return Boolean(
    workspace.state === "deletion_pending" ||
      workspace.dirty ||
      workspace.unpushed ||
      workspace.blockerCount > 0 ||
      workspace.attentionReasons?.length,
  );
}

export function countWorkspaceFilter(
  workspaces: WorkspaceSummary[],
  filter: WorkspaceFilter,
): number {
  return workspaces.filter((workspace) => matchesWorkspaceFilter(workspace, filter)).length;
}

export function defaultTreeMode(files: FileChange[]): "tree" | "files" {
  return files.length <= 3 ? "files" : "tree";
}

export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function defaultExpandedPaths(files: FileChange[], selectedPath = ""): Set<string> {
  if (files.length <= 3) return new Set();
  return new Set(selectedPath ? ancestorPaths(selectedPath) : []);
}

function directoryForPath(root: MutableTreeDirectory, parts: string[], file: FileChange): void {
  if (parts.length === 1) {
    root.files.push(file);
    return;
  }
  const directoryPath = parts[0];
  const childPath = root.path ? `${root.path}/${directoryPath}` : directoryPath;
  let child = root.directories.get(directoryPath);
  if (!child) {
    child = {
      kind: "directory",
      path: childPath,
      label: directoryPath,
      directories: new Map(),
      files: [],
    };
    root.directories.set(directoryPath, child);
  }
  directoryForPath(child, parts.slice(1), file);
}

function directoryStats(directory: MutableTreeDirectory): {
  fileCount: number;
  additions: number;
  deletions: number;
} {
  const own = directory.files.reduce(
    (total, file) => ({
      fileCount: total.fileCount + 1,
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
  for (const child of directory.directories.values()) {
    const stats = directoryStats(child);
    own.fileCount += stats.fileCount;
    own.additions += stats.additions;
    own.deletions += stats.deletions;
  }
  return own;
}

export function buildTreeRows(
  files: FileChange[],
  expandedPaths: ReadonlySet<string>,
  selectedPath = "",
): TreeRow[] {
  const root: MutableTreeDirectory = {
    kind: "directory",
    path: "",
    label: "",
    directories: new Map(),
    files: [],
  };
  for (const file of files) {
    directoryForPath(root, file.path.split("/"), file);
  }
  const rows: TreeRow[] = [];
  const append = (directory: MutableTreeDirectory, depth: number): void => {
    for (const child of [...directory.directories.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const stats = directoryStats(child);
      rows.push({
        kind: "directory",
        path: child.path,
        label: child.label,
        depth,
        ...stats,
      });
      if (expandedPaths.has(child.path) || ancestorPaths(selectedPath).includes(child.path)) {
        append(child, depth + 1);
      }
    }
    for (const file of [...directory.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", file, depth });
    }
  };
  append(root, 0);
  return rows;
}

export type GraphConnection = {
  from: number;
  to: number;
  sha: string;
  terminal?: boolean;
  colorIndex?: number;
};

export type GraphRow = {
  node: CommitNode;
  lane: number;
  laneCount: number;
  lanesBefore: string[];
  lanesAfter: string[];
  laneColorsBefore: number[];
  laneColorsAfter: number[];
  colorIndex: number;
  laneTransitions: GraphConnection[];
  parentLanes: GraphConnection[];
};

export function layoutGraph(nodes: CommitNode[]): GraphRow[] {
  const loadedShas = new Set(nodes.map((node) => node.sha));
  let lanes: string[] = [];
  let laneColors: number[] = [];
  let nextColor = 1;
  return nodes.map((node) => {
    let lane = lanes.indexOf(node.sha);
    if (lane < 0) {
      lane = 0;
      const colorIndex = lanes.length ? nextColor++ : 0;
      lanes = [node.sha, ...lanes.filter((sha) => sha !== node.sha)];
      laneColors = [colorIndex, ...laneColors];
    }
    const lanesBefore = [...lanes];
    const laneColorsBefore = [...laneColors];
    const colorIndex = laneColors[lane] ?? 0;
    const nextLanes = lanes.slice();
    const nextLaneColors = laneColors.slice();
    nextLanes.splice(lane, 1);
    nextLaneColors.splice(lane, 1);
    const parentLanes: GraphConnection[] = [];
    let terminalLaneOffset = 0;
    for (const [parentIndex, parent] of node.parents.entries()) {
      if (!loadedShas.has(parent)) {
        const terminalLane = Math.max(nextLanes.length + terminalLaneOffset, lane + 1);
        terminalLaneOffset += 1;
        parentLanes.push({
          from: lane,
          to: terminalLane,
          sha: parent,
          terminal: true,
          colorIndex: parentIndex === 0 ? colorIndex : nextColor++,
        });
        continue;
      }
      let parentLane = nextLanes.indexOf(parent);
      let parentColor = parentIndex === 0 ? colorIndex : undefined;
      if (parentLane < 0) {
        parentLane = Math.min(lane + parentIndex, nextLanes.length);
        parentColor = parentColor ?? nextColor++;
        nextLanes.splice(parentLane, 0, parent);
        nextLaneColors.splice(parentLane, 0, parentColor);
      } else {
        parentColor = nextLaneColors[parentLane] ?? parentColor ?? colorIndex;
      }
      parentLanes.push({ from: lane, to: parentLane, sha: parent, colorIndex: parentColor });
    }
    const uniqueLanes: string[] = [];
    const uniqueLaneColors: number[] = [];
    nextLanes.forEach((sha, index) => {
      if (uniqueLanes.includes(sha)) return;
      uniqueLanes.push(sha);
      uniqueLaneColors.push(nextLaneColors[index] ?? colorIndex);
    });
    lanes = uniqueLanes;
    laneColors = uniqueLaneColors;
    const laneTransitions: GraphConnection[] = [];
    for (const [from, sha] of lanesBefore.entries()) {
      if (sha === node.sha) continue;
      const to = lanes.indexOf(sha);
      if (to >= 0) laneTransitions.push({ from, to, sha, colorIndex: laneColorsBefore[from] ?? 0 });
    }
    laneTransitions.push(...parentLanes);
    const laneCount = Math.max(
      1,
      lanesBefore.length,
      lanes.length,
      lane,
      ...laneTransitions.flatMap((connection) => [connection.from, connection.to]),
    );
    return {
      node,
      lane,
      laneCount,
      lanesBefore,
      lanesAfter: [...lanes],
      laneColorsBefore,
      laneColorsAfter: [...laneColors],
      colorIndex,
      laneTransitions,
      parentLanes,
    };
  });
}

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type ParsedPatch = {
  prelude: string[];
  hunks: DiffHunk[];
};

export type DiffDisplayMode = "split" | "unified";

export type DiffDisplayRow =
  | { kind: "hunk"; hunk: DiffHunk; hunkIndex: number; key: string }
  | { kind: "unified"; hunkIndex: number; line: DiffLine; key: string }
  | { kind: "split"; hunkIndex: number; left: DiffLine | null; right: DiffLine | null; key: string };

export const DIFF_HUNK_ROW_HEIGHT = 27;
export const DIFF_LINE_ROW_HEIGHT = 22;

export type DiffOverviewMarkerKind = "added" | "removed" | "modified";

export type DiffOverviewMarker = {
  hunkIndex: number;
  kind: DiffOverviewMarkerKind;
  startLine: number;
  endLine: number;
  /** Start position in the rendered diff content, normalized to the inclusive [0, 1] range. */
  position: number;
  /** Marker height in the rendered diff content, normalized to the inclusive [0, 1] range. */
  extent: number;
};

const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedPatch(patch: string): ParsedPatch {
  const prelude: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    const match = hunkPattern.exec(rawLine);
    if (match) {
      current = {
        header: rawLine,
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (
        rawLine &&
        !rawLine.startsWith("diff --git") &&
        !rawLine.startsWith("index ") &&
        !rawLine.startsWith("--- ") &&
        !rawLine.startsWith("+++ ")
      ) {
        prelude.push(rawLine);
      }
      continue;
    }
    if (rawLine === "\\ No newline at end of file") continue;
    const prefix = rawLine.slice(0, 1);
    if (prefix === "+" || prefix === "-" || prefix === " ") {
      const kind: DiffLineKind = prefix === "+" ? "added" : prefix === "-" ? "removed" : "context";
      current.lines.push({
        kind,
        content: rawLine.slice(1),
        oldLine: kind === "added" ? null : oldLine++,
        newLine: kind === "removed" ? null : newLine++,
      });
      continue;
    }
    prelude.push(rawLine);
  }
  return { prelude, hunks };
}

export type SplitDiffPair = {
  left: DiffLine | null;
  right: DiffLine | null;
};

export function pairDiffLines(lines: DiffLine[]): SplitDiffPair[] {
  const pairs: SplitDiffPair[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      pairs.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "removed") removed.push(lines[index++]);
    while (index < lines.length && lines[index].kind === "added") added.push(lines[index++]);
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      pairs.push({ left: removed[offset] || null, right: added[offset] || null });
    }
  }
  return pairs;
}

export function buildDiffDisplayRows(parsed: ParsedPatch, mode: DiffDisplayMode): DiffDisplayRow[] {
  return parsed.hunks.flatMap((hunk, hunkIndex) => [
    { kind: "hunk" as const, hunk, hunkIndex, key: `hunk-${hunkIndex}` },
    ...(mode === "split"
      ? pairDiffLines(hunk.lines).map((pair, lineIndex) => ({
          kind: "split" as const,
          hunkIndex,
          left: pair.left,
          right: pair.right,
          key: `pair-${hunkIndex}-${lineIndex}`,
        }))
      : hunk.lines.map((line, lineIndex) => ({
          kind: "unified" as const,
          hunkIndex,
          line,
          key: `line-${hunkIndex}-${lineIndex}`,
        }))),
  ]);
}

export function diffDisplayRowHeight(row: DiffDisplayRow): number {
  return row.kind === "hunk" ? DIFF_HUNK_ROW_HEIGHT : DIFF_LINE_ROW_HEIGHT;
}

export type DiffDisplayRowMetrics = {
  offsets: number[];
  lengths: number[];
  contentHeight: number;
};

export function diffDisplayRowMetrics(rows: DiffDisplayRow[]): DiffDisplayRowMetrics {
  const offsets: number[] = [];
  const lengths: number[] = [];
  let contentHeight = 0;
  for (const row of rows) {
    offsets.push(contentHeight);
    const length = diffDisplayRowHeight(row);
    lengths.push(length);
    contentHeight += length;
  }
  return { offsets, lengths, contentHeight };
}

function changedLineNumber(line: DiffLine): number {
  return line.newLine ?? line.oldLine ?? 1;
}

function changedLinesForDisplayRow(row: DiffDisplayRow): DiffLine[] {
  if (row.kind === "unified") return row.line.kind === "context" ? [] : [row.line];
  if (row.kind === "split") {
    return [row.left, row.right].filter(
      (line): line is DiffLine => Boolean(line && line.kind !== "context"),
    );
  }
  return [];
}

/**
 * Build the small set of ranges rendered in the Diff overview rail.
 *
 * A contiguous removed + added block is represented as one modified range so
 * the overview matches how a side-by-side editor presents a changed hunk.
 */
export function buildDiffOverviewMarkers(rows: DiffDisplayRow[]): DiffOverviewMarker[] {
  const metrics = diffDisplayRowMetrics(rows);
  const markers: DiffOverviewMarker[] = [];

  if (!rows.length || !metrics.contentHeight) return markers;

  let active: {
    endOffset: number;
    hunkIndex: number;
    lines: DiffLine[];
    startOffset: number;
  } | null = null;

  const flush = () => {
    if (!active) return;
    const startLine = Math.min(...active.lines.map(changedLineNumber));
    const endLine = Math.max(...active.lines.map(changedLineNumber));
    const hasAdded = active.lines.some((line) => line.kind === "added");
    const hasRemoved = active.lines.some((line) => line.kind === "removed");
    const kind: DiffOverviewMarkerKind = hasAdded && hasRemoved
      ? "modified"
      : hasAdded
        ? "added"
        : "removed";
    markers.push({
      hunkIndex: active.hunkIndex,
      kind,
      startLine,
      endLine,
      position: Math.min(1, Math.max(0, active.startOffset / metrics.contentHeight)),
      extent: Math.min(1, Math.max(1 / metrics.contentHeight, (active.endOffset - active.startOffset) / metrics.contentHeight)),
    });
    active = null;
  };

  rows.forEach((row, index) => {
    const changed = changedLinesForDisplayRow(row);
    if (!changed.length) {
      flush();
      return;
    }
    if (!active || active.hunkIndex !== row.hunkIndex) {
      flush();
      active = {
        endOffset: metrics.offsets[index] + metrics.lengths[index],
        hunkIndex: row.hunkIndex,
        lines: [...changed],
        startOffset: metrics.offsets[index],
      };
      return;
    }
    active.endOffset = metrics.offsets[index] + metrics.lengths[index];
    active.lines.push(...changed);
  });
  flush();
  return markers;
}

export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".jsonc")) return "json5";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xml") || lower.endsWith(".svg")) return "markup";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
  if (lower.endsWith(".toml")) return "toml";
  return "plain";
}

export type DiffReferenceInput = {
  scope: "working" | "branch" | "commit";
  baseSha?: string | null;
  head?: string | null;
  commitSha?: string | null;
  branch?: string | null;
};

function shortReference(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}

function namedReference(label: string, value: string | null | undefined): string {
  const short = shortReference(value);
  return short ? `${label} ${short}` : label;
}

export function formatDiffReferences(input: DiffReferenceInput): { from: string; to: string } {
  if (input.scope === "working") {
    return {
      from: namedReference("HEAD", input.head),
      to: "working tree",
    };
  }
  if (input.scope === "commit") {
    return {
      from: namedReference("parent", input.baseSha),
      to: namedReference("commit", input.commitSha || input.head),
    };
  }
  return {
    from: namedReference("base", input.baseSha),
    to: namedReference("branch", input.branch),
  };
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

export function formatChangeCount(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

export function formatObservedTime(value: string | null | undefined, strings: WorkbenchCopy = copy): string {
  if (!value) return strings.text_6dbf7070d6;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return strings.text_9e636642d6;
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return strings.text_adea7d427f;
  if (delta < 3_600_000) return formatCopyFrom(strings, "text_61af484c81", [Math.floor(delta / 60_000)]);
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeTime(value: string | null | undefined, strings: WorkbenchCopy = copy): string {
  if (!value) return strings.text_fcd9714424;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return strings.text_6478dde454;
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return strings.text_9e636642d6;
  if (delta < 3_600_000) return formatCopyFrom(strings, "text_607909447d", [Math.floor(delta / 60_000)]);
  if (delta < 86_400_000) return formatCopyFrom(strings, "text_87a6439b2e", [Math.floor(delta / 3_600_000)]);
  return formatCopyFrom(strings, "text_9094e27946", [Math.floor(delta / 86_400_000)]);
}
import { copy, formatCopyFrom, type WorkbenchCopy } from "../shared/copy.ts";
