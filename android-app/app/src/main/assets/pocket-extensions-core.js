(function createPocketExtensions(options) {
  'use strict';
  // Runs in the trusted page's JS realm. Registration and UI never cross JNI.
  const sessions = new Set(), clients = new WeakMap(), listeners = new Set(), catalogs = new Map();
  let registry = null, unsubscribe = null, enabled = true, closed = false, sequence = 0, revision = 0;
  let currentContext = null, scheduled = false;
  const idPattern = /^[a-z][a-z0-9-]*$/;
  const noopRegistration = Object.freeze({ update() {}, dispose() {} });
  const report = code => { try { options.report?.(code); } catch (_) {} };
  function emit() { revision++; for (const fn of [...listeners]) { try { fn(); } catch (_) { report('extension_listener_failed'); } } }
  function contextFor(session) { return !session.disposed && session.owner?.serverId === currentContext?.hostId ? currentContext : null; }
  function publishContext(session) {
    const next = contextFor(session);
    if (session.context === next) return;
    session.context = next;
    for (const fn of [...session.listeners]) { try { fn(); } catch (_) { report('extension_listener_failed'); } }
  }
  function disposeSession(session) {
    if (session.disposed) return;
    session.disposed = true;
    clients.delete(session.client.paseo);
    session.owner?.lifetime.signal.removeEventListener('abort', session.abort);
    session.panels.clear(); sessions.delete(session); publishContext(session); session.listeners.clear(); emit();
  }
  function reconcile() {
    scheduled = false;
    if (closed || !registry) return;
    const installed = registry.getSnapshot();
    for (const session of [...sessions]) {
      const owner = installed.find(plugin => plugin.paseo === session.client.paseo);
      if (!owner || owner.lifetime.signal.aborted) {
        // Setup and registry publication finish in the same synchronous catalog turn.
        disposeSession(session); continue;
      }
      if (session.owner !== owner) {
        session.owner = owner; owner.lifetime.signal.addEventListener('abort', session.abort, { once: true });
      }
      publishContext(session);
    }
    emit();
  }
  function schedule() {
    if (scheduled || closed || !registry) return;
    scheduled = true; queueMicrotask(reconcile);
  }
  const validId = value => typeof value === 'string' && idPattern.test(value);
  function validPanel(value) {
    return value && validId(value.id) && typeof value.title === 'string' && value.title.trim() &&
      typeof value.icon === 'string' && value.icon.trim() && value.location === 'right-sidebar' &&
      value.content && validId(value.content.workspacePanelId) &&
      (value.enabled === undefined || typeof value.enabled === 'boolean') &&
      (value.content.agentPanelId === undefined || validId(value.content.agentPanelId));
  }
  function connect(client) {
    if (closed || !enabled || !client?.paseo || typeof client.paseo !== 'object') return null;
    const previous = clients.get(client.paseo);
    if (previous && !previous.disposed) return previous.api;
    const session = { client, owner: null, sequence: ++sequence, panels: new Map(), listeners: new Set(), context: null, disposed: false };
    session.abort = () => disposeSession(session); sessions.add(session);
    const api = Object.freeze({
      protocolVersion: 1,
      supports: name => !session.disposed && enabled && name === 'ui.panel.right-sidebar',
      context: Object.freeze({ getSnapshot: () => session.context,
        subscribe(fn) { if (session.disposed || typeof fn !== 'function') return () => {}; session.listeners.add(fn); return () => session.listeners.delete(fn); } }),
      ui: Object.freeze({ registerPanel(value) {
        if (session.disposed || !enabled) return noopRegistration;
        if (!validPanel(value) || session.panels.has(value.id)) { report('extension_registration_invalid'); return noopRegistration; }
        let disposed = false;
        const panel = { ...value, title: value.title.trim(), icon: value.icon.trim(), content: { ...value.content } };
        session.panels.set(panel.id, panel); emit();
        return Object.freeze({ update(patch) {
          if (disposed || session.disposed || !patch) return;
          let changed = false;
          for (const field of ['title', 'icon', 'enabled']) {
            const next = field === 'enabled' ? patch[field] : typeof patch[field] === 'string' ? patch[field].trim() : undefined;
            if (next !== undefined && (field === 'enabled' ? typeof next === 'boolean' : !!next) && panel[field] !== next) { panel[field] = next; changed = true; }
          }
          if (changed) emit();
        }, dispose() { if (disposed) return; disposed = true; if (session.panels.delete(panel.id)) emit(); } });
      } }),
      dispose: () => disposeSession(session),
    });
    session.api = api; clients.set(client.paseo, session); schedule(); return api;
  }
  const api = Object.freeze({ protocolVersion: 1, connect });
  return {
    api,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => revision,
    attachRegistry(value) { if (closed || registry) return; registry = value; unsubscribe = registry.subscribe(schedule); schedule(); },
    catalog(hostId, entries) { catalogs.set(hostId, new Set(entries.map(entry => entry.id))); schedule(); },
    hasPlugin(hostId, pluginId) { return catalogs.get(hostId)?.has(pluginId); },
    setContext(value) {
      if (value?.hostId === currentContext?.hostId && value?.workspaceId === currentContext?.workspaceId && value?.agentId === currentContext?.agentId) return;
      currentContext = value ? Object.freeze({ ...value }) : null;
      for (const session of sessions) publishContext(session);
    },
    panels(hostId) {
      if (!enabled || closed) return [];
      const result = [];
      for (const session of sessions) {
        const owner = session.owner;
        if (!owner || session.disposed || owner.serverId !== hostId || owner.lifetime.signal.aborted) continue;
        for (const panel of session.panels.values()) {
          if (panel.enabled === false) continue;
          const workspace = owner.workspacePanels.find(item => item.id === panel.content.workspacePanelId && item.context === 'workspace');
          const agent = owner.workspacePanels.find(item => item.id === panel.content.agentPanelId && item.context === 'agent');
          if (!workspace) continue;
          result.push({ ...panel, owner, workspace, agent, key: JSON.stringify([owner.serverId, owner.id, session.sequence, panel.id]),
            preferenceKey: JSON.stringify([owner.id, panel.id]) });
        }
      }
      return result.sort((a, b) => a.owner.id.localeCompare(b.owner.id) || a.id.localeCompare(b.id));
    },
    disable() { if (!enabled) return; enabled = false; for (const session of [...sessions]) disposeSession(session); emit(); },
    dispose() { if (closed) return; closed = true; unsubscribe?.(); for (const session of [...sessions]) disposeSession(session); listeners.clear(); registry = null; catalogs.clear(); },
    debug: () => ({ sessions: sessions.size, listeners: listeners.size, enabled, revision }),
  };
})
