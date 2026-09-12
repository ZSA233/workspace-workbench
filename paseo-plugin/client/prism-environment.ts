// This module must execute before Prism core. The workbench tokenizes strings;
// it never asks Prism to inspect a document or start a worker.
const root = globalThis as unknown as {
  Prism?: Record<string, unknown>;
  window?: { Prism?: Record<string, unknown> };
};
const target = root.window || root;
target.Prism = { ...target.Prism, manual: true, disableWorkerMessageHandler: true };
