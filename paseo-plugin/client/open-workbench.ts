export function contextSurfacePrefix(workspaceId: string): string {
  // Fixed-width UTF-16 encoding is collision-free, including non-ASCII IDs.
  const encode = (value: string) => value.split("").map((char) => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return `workspace-workbench-context-${encode(workspaceId)}-`;
}

export function workbenchDestination(platform: string, workspaceId: string, agentId?: string) {
  return platform === "web"
    ? { kind: "panel" as const, id: agentId ? "workspace-workbench-agent" : "workspace-workbench-workspace", options: { workspaceId, ...(agentId ? { agentId } : {}), location: "explorer" as const } }
    : { kind: "surface" as const, id: `${contextSurfacePrefix(workspaceId)}${contextSurfacePrefix(agentId || "")}` };
}

// Initialization should use plain closures, not dynamically evaluated class
// constructors. This also keeps the entrypoint free of class-field helpers.
export function createOpenGuard() {
  let lastKey = "";
  let lastAt = 0;
  return {
    allow(key: string, now = Date.now()): boolean {
      if (key === lastKey && now - lastAt < 400) return false;
      lastKey = key;
      lastAt = now;
      return true;
    },
  };
}
