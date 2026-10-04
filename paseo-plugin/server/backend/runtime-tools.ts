export const runtimeTools: Record<
  string,
  {
    names: string[];
    args: string[];
    pattern: RegExp;
    cache: Record<string, string>;
  }
> = {
  node: {
    names: ["node"],
    args: ["--version"],
    pattern: /\bv(\d+\.\d+(?:\.\d+)?)/,
    cache: { NPM_CONFIG_CACHE: "npm" },
  },
  python: {
    names: ["python", "python3"],
    args: ["--version"],
    pattern: /\bPython\s+(\d+\.\d+(?:\.\d+)?)/,
    cache: { PIP_CACHE_DIR: "pip" },
  },
  go: {
    names: ["go"],
    args: ["version"],
    pattern: /\bgo(\d+\.\d+(?:\.\d+)?)/,
    cache: { GOCACHE: "go-build", GOMODCACHE: "go-mod" },
  },
};
