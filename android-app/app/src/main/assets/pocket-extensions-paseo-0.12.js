(function installPaseo012Extensions(config, core, callbacks) {
  'use strict';
  // Private, fingerprint-pinned host integration. Never exported through the SDK.
  const fingerprint = '0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381';
  if (config.webVersion !== '0.12.0' || config.bundleSha256 !== fingerprint) return null;
  const modules = Object.freeze({ react: 37, dom: 392, registry: 3680, sidebar: 4604,
    panelStore: 4047, layout: 3809, sessions: 3659, stateSource: 3902,
    environment: 4456, boundary: 4459, theme: 58, pluginTheme: 4460, navigation: 4975, navigationFactory: 3907, toast: 897, icons: 3920 });
  const pending = new Set([modules.registry, modules.sidebar]);
  const cleanups = []; let disposed = false, originalDefine = null, hookedDefine = null, readModule = null;
  let closeSidebar = null, foreground = true, visible = false;
  let openRegisteredPanel = null;
  const activityListeners = new Set();
  const report = code => callbacks.report(code);
  const emitActivity = () => { for (const listener of [...activityListeners]) listener(); };
  const rememberKey = 'pocket.extensions.sidebar.v1';
  let remembered;
  function preferences() {
    if (remembered) return remembered;
    try { const value = JSON.parse(localStorage.getItem(rememberKey) || '[]'); remembered = new Map(Array.isArray(value) ? value.filter(row => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string').slice(-256) : []); }
    catch (_) { remembered = new Map(); }
    return remembered;
  }
  function remember(scope, selection) {
    const values = preferences(); values.delete(scope); values.set(scope, selection);
    while (values.size > 256) values.delete(values.keys().next().value);
    try { localStorage.setItem(rememberKey, JSON.stringify([...values])); } catch (_) { /* Disposable UI preference. */ }
  }
  function forget(scope) {
    if (!preferences().delete(scope)) return;
    try { localStorage.setItem(rememberKey, JSON.stringify([...preferences()])); } catch (_) {}
  }
  function prunePreferences(hostId, workspaceExists) {
    let changed = false;
    for (const [scope, selection] of preferences()) {
      try {
        const [host, workspaceId] = JSON.parse(scope);
        if (host !== hostId) continue;
        const missingWorkspace = workspaceExists && !workspaceExists(workspaceId);
        const missingPlugin = !selection.startsWith('builtin:') && core.hasPlugin(hostId, JSON.parse(selection)[0]) === false;
        if (missingWorkspace || missingPlugin) { preferences().delete(scope); changed = true; }
      } catch (_) { /* Ignore an old malformed preference. */ }
    }
    if (changed) try { localStorage.setItem(rememberKey, JSON.stringify([...preferences()])); } catch (_) {}
  }
  function module(name) { return readModule(modules[name]); }
  function restoreDefine() {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__d');
    if (descriptor?.set === receiveDefine || descriptor?.value === hookedDefine)
      Object.defineProperty(window, '__d', { configurable: true, writable: true, value: originalDefine || undefined });
  }
  function disable(code) { report(code); core.disable(); restoreDefine(); }
  function afterFactory(id, exports, require) {
    if (disposed) return;
    readModule = require;
    if (id === modules.registry) {
      const registry = exports.pluginRegistry;
      if (!registry?.getSnapshot || !registry?.subscribe || !registry?.installCatalog) throw Error('registry exports');
      core.attachRegistry(registry);
      const original = registry.installCatalog;
      const wrapped = function(hostId, entries, options) {
        const result = original.call(this, hostId, entries, options);
        core.catalog(hostId, entries); return result;
      };
      registry.installCatalog = wrapped;
      cleanups.push(() => { if (registry.installCatalog === wrapped) registry.installCatalog = original; });
      // Paseo 0.12 routes explorer openPanel() calls to a desktop pane even on mobile.
      // Registered sidebar panels use the existing mobile overlay instead, keeping the
      // conversation/file view and this installation's retained panel instance intact.
      const navigation = module('navigationFactory'), create = navigation.createPluginNavigation;
      if (typeof create !== 'function') throw Error('navigation exports');
      const createNavigation = function(options) {
        const value = create(options);
        return { ...value,
          openWorkspacePanel(pluginId, panelId, location) {
            if (location === 'explorer' && openRegisteredPanel?.({ ...options, pluginId, panelId })) return;
            return value.openWorkspacePanel(pluginId, panelId, location);
          },
          openAgentPanel(pluginId, panelId, agentId, location) {
            if (location === 'explorer' && openRegisteredPanel?.({ ...options, pluginId, panelId, agentId })) return;
            return value.openAgentPanel(pluginId, panelId, agentId, location);
          } };
      };
      navigation.createPluginNavigation = createNavigation;
      cleanups.push(() => { if (navigation.createPluginNavigation === createNavigation) navigation.createPluginNavigation = create; });
    } else {
      const Original = exports.CompactExplorerSidebar, React = module('react');
      if (typeof Original !== 'function' || typeof React.createElement !== 'function') throw Error('sidebar exports');
      class ExtensionBoundary extends React.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { disable('extension_adapter_unavailable'); }
        render() { return this.state.failed ? null : this.props.children; }
      }
      function PocketExplorer(props) {
        return React.createElement(React.Fragment, null, React.createElement(Original, props),
          React.createElement(ExtensionBoundary, null,
            React.createElement(PocketPortals, { sidebar: props, key: JSON.stringify([props.serverId, props.workspaceId]) })));
      }
      exports.CompactExplorerSidebar = PocketExplorer;
      cleanups.push(() => { if (exports.CompactExplorerSidebar === PocketExplorer) exports.CompactExplorerSidebar = Original; });
    }
  }
  function receiveDefine(value) {
    if (typeof value !== 'function') { disable('extension_adapter_unavailable'); return; }
    originalDefine = value;
    hookedDefine = function(factory, id, dependencies, ...rest) {
      if (!pending.has(id)) return originalDefine(factory, id, dependencies, ...rest);
      pending.delete(id);
      const wrapped = function(...args) {
        // The host module always runs once; adaptation errors cannot retry or swallow it.
        const result = factory.apply(this, args);
        try { afterFactory(id, args[4].exports, args[1]); } catch (_) { disable('extension_adapter_unavailable'); }
        return result;
      };
      const result = originalDefine(wrapped, id, dependencies, ...rest);
      if (!pending.size) restoreDefine();
      return result;
    };
    Object.defineProperty(window, '__d', { configurable: true, writable: true, value: hookedDefine });
  }

  function focusTarget(layout) {
    if (!layout) return null;
    const api = module('layout'), pane = api.findPaneById(layout.root, layout.focusedPaneId);
    const candidates = pane ? [pane] : api.collectAllPanes(layout.root);
    for (const value of candidates) {
      const tab = value.tabs?.find(item => item.tabId === value.focusedTabId || item.id === value.focusedTabId);
      if (tab) return { key: tab.tabId || tab.id, target: tab.target };
    }
    return null;
  }
  function PanelBody({ panel, context, active, theme }) {
    const React = module('react'), toast = module('toast').useToast();
    const navigation = module('navigation').usePluginHostNavigation(context.hostId);
    const state = React.useMemo(() => module('stateSource').createPluginClientStateSource(context.hostId), [context.hostId]);
    const agent = context.agentId && state.getAgent(context.agentId);
    const contribution = agent?.workspaceId === context.workspaceId && panel.agent ? panel.agent : panel.workspace;
    const props = { theme, host: { id: panel.owner.serverId, label: window.__paseoHostRuntimeStore?.getHosts().find(host => host.serverId === panel.owner.serverId)?.label || panel.owner.serverId },
      layout: { compact: true, platform: 'web' }, navigation, workspaceId: context.workspaceId,
      context: contribution.context, ...(contribution.context === 'agent' ? { agentId: context.agentId } : {}) };
    const environment = React.useMemo(() => ({ installation: panel.owner, toast, state }), [panel.owner, toast, state]);
    return React.createElement('div', { 'data-pocket-panel': panel.id, 'data-pocket-panel-key': panel.key,
      'data-testid': `pocket-panel-${panel.owner.id}-${panel.id}`, hidden: !active,
      style: { display: active ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden', background: theme.colors.surface0 } },
      React.createElement(module('boundary').SurfaceErrorBoundary, { installation: panel.owner, Surface: contribution.Component },
        React.createElement(module('environment').PluginEnvironmentProvider, { environment }, React.createElement(contribution.Component, props))));
  }
  function PocketPortals({ sidebar }) {
    const React = module('react'), { serverId: hostId, workspaceId } = sidebar;
    const usePanelStore = module('panelStore').usePanelStore;
    const isOpen = usePanelStore(state => state.mobilePanel.target === 'file-explorer');
    const builtin = usePanelStore(state => state.explorerTab);
    const layout = module('layout').useWorkspaceLayoutStore(state => state.layoutByWorkspace[`${hostId}:${workspaceId}`]);
    const workspaces = module('sessions').useSessionStore(state => state.sessions[hostId]?.workspaces);
    const target = focusTarget(layout), focused = target?.target;
    const candidate = focused?.kind === 'agent' || (focused?.kind === 'plugin' && focused.context === 'agent') ? focused.agentId : undefined;
    const agentWorkspace = module('sessions').useSessionStore(state => candidate ? (state.sessions[hostId]?.agents.get(candidate) || state.sessions[hostId]?.agentDetails.get(candidate))?.workspaceId : undefined);
    const context = React.useMemo(() => {
      const agent = candidate && module('stateSource').createPluginClientStateSource(hostId).getAgent(candidate);
      return { hostId, workspaceId, ...(agent?.workspaceId === workspaceId ? { agentId: candidate } : {}) };
    }, [hostId, workspaceId, candidate, agentWorkspace]);
    const scope = JSON.stringify([hostId, workspaceId]);
    const [selection, setSelection] = React.useState(() => preferences().get(scope) || null);
    const [targets, setTargets] = React.useState(null), [mounted, setMounted] = React.useState([]);
    const [appForeground, setAppForeground] = React.useState(foreground);
    const previousTarget = React.useRef(target?.key);
    const revision = React.useSyncExternalStore(core.subscribe, core.getSnapshot, core.getSnapshot);
    const panels = core.panels(hostId), selected = panels.find(panel => panel.preferenceKey === selection) || null;
    const { theme: hostTheme } = module('theme').useUnistyles();
    const theme = React.useMemo(() => module('pluginTheme').toPluginTheme(hostTheme), [hostTheme]);
    const activate = React.useCallback(value => { remember(scope, value); setSelection(value); }, [scope]);

    React.useEffect(() => {
      const open = request => {
        if (request.serverId !== hostId || request.workspaceId !== workspaceId) return false;
        const panel = core.panels(hostId).find(item => item.owner.id === request.pluginId &&
          (request.agentId ? item.agent?.id : item.workspace.id) === request.panelId);
        if (!panel) return false;
        if (request.agentId) {
          const agent = module('stateSource').createPluginClientStateSource(hostId).getAgent(request.agentId);
          if (agent?.workspaceId !== workspaceId) return false;
        }
        activate(panel.preferenceKey);
        usePanelStore.getState().openCompactFileExplorer({ serverId: hostId, cwd: sidebar.workspaceRoot, isGit: sidebar.isGit });
        return true;
      };
      openRegisteredPanel = open;
      return () => { if (openRegisteredPanel === open) openRegisteredPanel = null; };
    }, [hostId, workspaceId, activate, sidebar.workspaceRoot, sidebar.isGit]);

    React.useEffect(() => {
      const listener = () => setAppForeground(foreground); activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    }, []);
    React.useEffect(() => {
      if (!workspaceId) return;
      core.setContext(context);
      return () => core.setContext(null);
    }, [context, workspaceId]);
    React.useEffect(() => {
      closeSidebar = () => usePanelStore.getState().showMobileAgent();
      visible = isOpen; callbacks.state(isOpen);
      return () => { visible = false; closeSidebar = null; callbacks.state(false); };
    }, [isOpen]);
    React.useEffect(() => {
      if (isOpen && selected && target?.key && previousTarget.current && previousTarget.current !== target.key) usePanelStore.getState().showMobileAgent();
      previousTarget.current = target?.key;
    }, [target?.key, isOpen, selected?.key]);
    React.useEffect(() => {
      if (!selection || selection.startsWith('builtin:') || selected) return;
      let pluginId; try { pluginId = JSON.parse(selection)[0]; } catch (_) { return; }
      if (core.hasPlugin(hostId, pluginId) === false) activate('builtin:' + builtin);
    }, [selection, selected?.key, revision, hostId, builtin, activate]);
    React.useLayoutEffect(() => {
      if (!isOpen || !selection?.startsWith('builtin:')) return;
      const tab = selection.slice('builtin:'.length);
      if (tab === builtin || !['files', 'changes', 'pr'].includes(tab) || (!sidebar.isGit && tab !== 'files')) return;
      usePanelStore.getState().setExplorerTabForCheckout({ serverId: hostId, cwd: sidebar.workspaceRoot, isGit: sidebar.isGit, tab });
    }, [isOpen, selection, builtin, hostId, sidebar.workspaceRoot, sidebar.isGit]);
    React.useEffect(() => {
      const state = module('stateSource').createPluginClientStateSource(hostId);
      const complete = workspaces && window.__paseoHostRuntimeStore?.getSnapshot(hostId)?.agentDirectoryStatus === 'ready';
      prunePreferences(hostId, complete ? id => !!state.getWorkspace(id) : null);
      if (complete && !state.getWorkspace(workspaceId)) { forget(scope); setMounted([]); }
    }, [workspaces, workspaceId, hostId, scope, revision]);
    React.useEffect(() => {
      if (!isOpen || !selected) return;
      setMounted(previous => previous[previous.length - 1] === selected.key ? previous : [...previous.filter(key => key !== selected.key && panels.some(panel => panel.key === key)), selected.key].slice(-2));
    }, [isOpen, selected?.key]);

    React.useLayoutEffect(() => {
      if (!isOpen || targets) return;
      let observer = null, timer = null;
      function attach() {
        const header = document.querySelector('[data-testid="explorer-header"]');
        const content = header?.parentElement?.querySelector('[data-testid="explorer-content-area"]');
        const builtInTab = header?.querySelector('[data-testid^="explorer-tab-"]');
        if (!header || !content || !builtInTab) return false;
        const rail = builtInTab.parentElement, tabs = document.createElement('div'), body = document.createElement('div');
        tabs.dataset.pocketTabs = ''; tabs.style.display = 'contents';
        body.dataset.pocketBody = ''; body.style.cssText = 'position:absolute;inset:0;display:none;flex-direction:column;min-width:0;min-height:0;z-index:1;';
        rail.append(tabs); content.append(body);
        const savedRail = rail.getAttribute('style'), savedRole = rail.getAttribute('role');
        Object.assign(rail.style, { flex: '1 1 0%', minWidth: '0', overflowX: 'auto', scrollbarWidth: 'none' });
        rail.setAttribute('role', 'tablist');
        const click = event => {
          const tab = event.target.closest('[data-testid^="explorer-tab-"]');
          if (tab && rail.contains(tab)) activate('builtin:' + tab.dataset.testid.slice('explorer-tab-'.length));
        };
        rail.addEventListener('click', click, true);
        const disposeTargets = () => {
          rail.removeEventListener('click', click, true); rail.removeAttribute('data-pocket-selected'); content.removeAttribute('data-pocket-selected');
          if (savedRail === null) rail.removeAttribute('style'); else rail.setAttribute('style', savedRail);
          if (savedRole === null) rail.removeAttribute('role'); else rail.setAttribute('role', savedRole);
          tabs.remove(); body.remove();
        };
        setTargets({ header, rail, tabs, content, body, dispose: disposeTargets });
        observer?.disconnect(); clearTimeout(timer); return true;
      }
      if (!attach()) {
        observer = new MutationObserver(attach); observer.observe(document.body, { childList: true, subtree: true });
        timer = setTimeout(() => observer.disconnect(), 3000);
      }
      return () => { observer?.disconnect(); clearTimeout(timer); };
    }, [isOpen, targets, activate]);
    React.useLayoutEffect(() => () => targets?.dispose(), [targets]);
    React.useLayoutEffect(() => {
      if (!targets) return;
      targets.rail.toggleAttribute('data-pocket-selected', !!selected);
      targets.content.toggleAttribute('data-pocket-selected', !!selected);
      targets.rail.style.setProperty('--pocket-muted', theme.colors.foregroundMuted);
      targets.body.style.display = selected && appForeground ? 'flex' : 'none';
      for (const tab of targets.rail.querySelectorAll('[data-testid^="explorer-tab-"]')) {
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(!selected && tab.dataset.testid === `explorer-tab-${builtin}`));
      }
    }, [targets, selected?.key, builtin, appForeground, theme]);

    if (!targets || !workspaceId) return null;
    const portal = module('dom').createPortal;
    const tabNodes = panels.map(panel => {
      let Icon;
      try { Icon = module('icons').resolvePluginIcon(panel.icon); } catch (_) { report('extension_registration_invalid'); }
      return React.createElement('button', { key: panel.key, type: 'button', role: 'tab',
      'aria-selected': selected?.key === panel.key, 'data-testid': `pocket-tab-${panel.owner.id}-${panel.id}`,
      onClick: () => activate(panel.preferenceKey), title: panel.title,
      style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, border: 0, borderRadius: 6, padding: '8px', font: 'inherit', fontSize: 14, whiteSpace: 'nowrap', cursor: 'pointer',
        background: selected?.key === panel.key ? theme.colors.surface2 : 'transparent', color: selected?.key === panel.key ? theme.colors.foreground : theme.colors.foregroundMuted } },
      Icon ? React.createElement(Icon, { size: 14, color: theme.colors.foregroundMuted }) : null, panel.title);
    });
    const retained = mounted.filter(key => panels.some(panel => panel.key === key));
    if (isOpen && selected && !retained.includes(selected.key)) retained.push(selected.key);
    const bodies = retained.slice(-2).map(key => {
      const panel = panels.find(item => item.key === key);
      return React.createElement(PanelBody, { key, panel, context, theme, active: appForeground && selected?.key === key });
    });
    return React.createElement(React.Fragment, null, portal(tabNodes, targets.tabs), portal(bodies, targets.body));
  }

  if (window.__d !== undefined) return null; // Must precede the pinned Metro bootstrap.
  Object.defineProperty(window, '__d', { configurable: true, get: () => undefined, set: receiveDefine });
  const style = document.createElement('style');
  style.textContent = '[data-pocket-selected]>:not([data-pocket-body]){display:none!important}' +
    '[role="tablist"][data-pocket-selected]>[data-testid^="explorer-tab-"]{display:flex!important;background:transparent!important}' +
    '[role="tablist"][data-pocket-selected]>[data-testid^="explorer-tab-"]>div{color:var(--pocket-muted)!important}' +
    '[role="tablist"][data-pocket-selected]>[data-pocket-tabs]{display:contents!important}';
  function insertStyle() { (document.head || document.documentElement)?.append(style); }
  if (document.documentElement) insertStyle(); else document.addEventListener('DOMContentLoaded', insertStyle, { once: true });
  function checkTargets() { if (pending.size) disable('extension_adapter_unavailable'); }
  document.addEventListener('DOMContentLoaded', checkTargets, { once: true });
  return {
    foreground(value) { if (foreground === !!value) return; foreground = !!value; emitActivity(); },
    handleBack() { if (!visible || !closeSidebar) return false; closeSidebar(); return true; },
    dispose() {
      if (disposed) return; disposed = true; core.disable(); restoreDefine();
      for (const cleanup of cleanups.reverse()) cleanup();
      style.remove(); document.removeEventListener('DOMContentLoaded', insertStyle); document.removeEventListener('DOMContentLoaded', checkTargets); activityListeners.clear();
    },
  };
})
