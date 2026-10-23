(function installPocketExtensions(config, createCore, installAdapter) {
  'use strict';
  if (window !== window.top || location.origin !== config.origin || window.Pocket) return null;
  const reported = new Set(), doc = crypto.randomUUID();
  let generation = null, sidebarOpen = false, disposed = false;
  function post(type, values = {}) {
    try { window.PocketExtensionsChannel?.postMessage(JSON.stringify({ token: config.token, doc, generation, type, ...values })); } catch (_) {}
  }
  function report(code) { if (reported.has(code) || reported.size >= 16) return; reported.add(code); post('diagnostic', { code }); }
  const core = createCore({ report });
  let adapter;
  try { adapter = installAdapter(config, core, { report, state: open => { sidebarOpen = open; if (generation) post('state', { open }); } }); }
  catch (_) { report('extension_adapter_unavailable'); }
  if (!adapter) { core.dispose(); return null; }
  Object.defineProperty(window, 'Pocket', { configurable: true, value: core.api });
  const dispose = () => { if (disposed) return; disposed = true; adapter.dispose(); core.dispose(); if (window.Pocket === core.api) delete window.Pocket; };
  window.addEventListener('pagehide', dispose, { once: true });
  post('hello');
  return Object.freeze({ activate(documentId, value) { if (disposed || documentId !== doc || generation) return; generation = value; post('activated'); post('state', { open: sidebarOpen }); },
    foreground: value => adapter.foreground(value), handleBack: () => adapter.handleBack(),
    dispose() { window.removeEventListener('pagehide', dispose); dispose(); } });
})
