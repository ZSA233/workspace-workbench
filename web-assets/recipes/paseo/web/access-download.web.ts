// HTTP only: this module never receives an Android bridge or private host address.
const prefix = "/__access/paseo";
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

interface DownloadInput {
  serverId: string;
  token: string;
  filename: string;
}

export async function tryAccessDownload(input: DownloadInput): Promise<boolean> {
  const capability = await fetch(prefix + "/capabilities", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (capability.status === 404 || capability.status === 405) return false;
  if (!capability.ok) throw new Error("Reopen the workbench to verify access before downloading.");
  const caps: unknown = await capability.json();
  if (
    !caps ||
    typeof caps !== "object" ||
    !("download_handoff_version" in caps) ||
    caps.download_handoff_version !== 1
  )
    return false;
  if (!tokenPattern.test(input.token)) throw new Error("Invalid source download credential.");
  const native = nativeDownload();
  const result = await fetch(prefix + "/downloads", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_id: input.serverId,
      token: input.token,
      filename: input.filename,
      transport: native ? "native" : "browser",
    }),
  });
  if (!result.ok) throw new Error("Download could not start; retry from the source file.");
  const value: unknown = await result.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("download_url" in value) ||
    typeof value.download_url !== "string"
  )
    throw new Error("Invalid download handoff.");
  const next = handoffURL(value.download_url, native);
  const link = document.createElement("a");
  link.href = next.href;
  link.download = input.filename;
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

function nativeDownload(): boolean {
  const native = /\bAccessPocket\/(\d+)\.(\d+)\.(\d+)/.exec(navigator.userAgent);
  const tooOld =
    native !== null &&
    Number(native[1]) === 0 &&
    (Number(native[2]) < 2 || (Number(native[2]) === 2 && Number(native[3]) < 9));
  const unsupportedWebView = native === null && /; wv\)/.test(navigator.userAgent);
  if (tooOld || unsupportedWebView) throw new Error("Update Access Pocket before saving files.");
  return native !== null;
}

function handoffURL(raw: string, native: boolean): URL {
  const next = new URL(raw, location.href);
  const suffix = native ? "start" : "content";
  const expectedPath = new RegExp("^" + prefix + "/downloads/[a-f0-9]{64}/" + suffix + "$");
  if (
    next.origin !== location.origin ||
    next.username ||
    next.password ||
    next.search ||
    next.hash ||
    !expectedPath.test(next.pathname)
  )
    throw new Error("Invalid download handoff.");
  return next;
}
