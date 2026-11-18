import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadStore } from "@/stores/download-store";

const platform = vi.hoisted(() => ({ web: true }));
vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return platform.web;
  },
  get isNative() {
    return !platform.web;
  },
}));
vi.mock("@/utils/access-download", () => import("@/utils/access-download.web"));

const origin = "https://paseo.example";
const prefix = "/__access/paseo";
const ticketPath = prefix + "/downloads/" + "a".repeat(64);
const token = "12345678-1234-1234-1234-123456789abc";
const filename = "交接材料.zip";
const bytes = new Uint8Array([1, 2, 3]);
const capabilities = () =>
  Response.json({ download_handoff_version: 1, entry_server_id: "srv_entry" });

const anchor = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
const fetch = vi.fn<typeof globalThis.fetch>();

function download() {
  const readFile = vi.fn(async () => ({ bytes, size: bytes.length }));
  const saveFile = vi.fn(async () => null);
  const promise = useDownloadStore.getState().startDownload({
    serverId: "srv_workspace",
    scopeId: "workspace-1",
    fileName: "Original name",
    path: "reports/file",
    daemonProfile: undefined,
    activeConnectionId: null,
    requestFileDownloadToken: async () => ({
      token,
      fileName: filename,
      mimeType: "application/zip",
      size: bytes.length,
      error: null,
    }),
    readFile,
    saveFile,
  });
  return { promise, readFile, saveFile };
}

function status() {
  const { downloads, activeDownloadId } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId)?.status : undefined;
}

describe("Access download handoff", () => {
  beforeEach(() => {
    platform.web = true;
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
    fetch.mockReset();
    anchor.click.mockReset();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", new URL(origin));
    vi.stubGlobal("navigator", { userAgent: "Chromium" });
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { userAgent: "AccessPocket/0.2.9", transport: "native", suffix: "/start" },
    { userAgent: "Chromium", transport: "browser", suffix: "/content" },
  ])("delegates through the actual HTTP adapter using $transport", async ({ userAgent, transport, suffix }) => {
    vi.stubGlobal("navigator", { userAgent });
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(
      Response.json({ download_url: ticketPath + suffix }),
    );
    const file = download();
    await file.promise;
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([prefix + "/capabilities", prefix + "/downloads"]);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      server_id: "srv_workspace",
      token,
      filename,
      transport,
    });
    expect(anchor.href).toBe(origin + ticketPath + suffix);
    expect(anchor.download).toBe(filename);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(status()).toBe("delegated");
    expect(file.readFile).not.toHaveBeenCalled();
    expect(file.saveFile).not.toHaveBeenCalled();
  });

  it.each([404, 405, 204, 200])("continues with Paseo's download when the capability is absent (HTTP %i)", async (code) => {
    fetch.mockResolvedValueOnce(code === 200
      ? new Response("<!doctype html><title>Paseo</title>", { headers: { "Content-Type": "text/html" } })
      : new Response(null, { status: code }));
    const file = download();
    await file.promise;
    expect(fetch).toHaveBeenCalledOnce();
    expect(anchor.click).not.toHaveBeenCalled();
    expect(status()).toBe("complete");
    expect(file.readFile).toHaveBeenCalledOnce();
    expect(file.saveFile).toHaveBeenCalledWith({ bytes, fileName: filename, mimeType: "application/zip" });
  });

  it("keeps the native Paseo download path", async () => {
    platform.web = false;
    const file = download();
    await file.promise;
    expect(fetch).not.toHaveBeenCalled();
    expect(file.saveFile).toHaveBeenCalledOnce();
    expect(status()).toBe("complete");
  });

  it.each([
    ["a rejected request", () => new Response(null, { status: 403 })],
    ["a non-Access URL", () => Response.json({ download_url: "/files/start" })],
    ["a different origin", () => Response.json({ download_url: "https://example.invalid" + ticketPath + "/content" })],
  ] as const)("reports %s without replaying the download", async (_label, response) => {
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(response());
    const file = download();
    await file.promise;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(status()).toBe("error");
    expect(anchor.click).not.toHaveBeenCalled();
    expect(file.readFile).not.toHaveBeenCalled();
    expect(file.saveFile).not.toHaveBeenCalled();
  });
});
