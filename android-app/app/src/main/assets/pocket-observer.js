(function pocketObserver(config) {
  'use strict';
  // APK-owned observer. Never changes the document, transports, host data or tasks.
  if (window !== window.top || location.origin !== 'https://appassets.androidplatform.net') return null;
  const doc = crypto.randomUUID();
  let generation = null, sequence = 0, disposed = false, active = false, inspecting = false;
  let store = null, attachTimer = null, verifyTimer = null, flushTimer = null, taskObserver = null, taskFlushTimer = null;
  let attachDeadline = 0, verifying = false, verifyStarted = 0, lastState = '';
  let taskCount = 0, taskTotal = 0, taskMax = 0;
  let nextSlot = 0;
  let pendingVerify = false;
  let lastTaskPost = -1000;
  const slots = new Map(), rtts = new Map(), unsubs = [];
  const now = () => performance.now();
  const channel = window.PocketObservationChannel;
  const post = (type, data = {}) => {
    if (disposed || (!generation && type !== 'hello')) return;
    try { channel.postMessage(JSON.stringify({ v: 1, token: config.token, doc,
      generation, seq: ++sequence, type, ...data })); } catch (_) { /* Diagnostics must not break the page. */ }
  };
  function fail(reason) {
    clearTimeout(attachTimer); clearTimeout(verifyTimer); clearTimeout(flushTimer); clearTimeout(taskFlushTimer);
    attachTimer = verifyTimer = flushTimer = null; verifying = false;
    for (const off of unsubs.splice(0)) { try { off(); } catch (_) {} }
    if (taskObserver) taskObserver.disconnect();
    taskObserver = null; store = null;
    post('unavailable', { reason });
  }
  function slot(id) { if (!slots.has(id)) slots.set(id, ++nextSlot); return slots.get(id); }
  function selectedHost() {
    try { const parts = location.pathname.split('/'); return parts[1] === 'h' ? decodeURIComponent(parts[2]) : null; }
    catch (_) { return null; }
  }
  function capture() {
    if (!store || disposed) return null;
    const selected = selectedHost();
    const profiles = store.getHosts().slice(0, 32);
    const currentIds = new Set(profiles.map(h => h.serverId));
    for (const id of slots.keys()) if (!currentIds.has(id)) { slots.delete(id); rtts.delete(id); }
    return profiles.map(host => {
      const snap = store.getSnapshot(host.serverId);
      const client = store.getClient(host.serverId);
      const status = snap?.connectionStatus;
      let phase = status === 'online' ? (snap.agentDirectoryStatus === 'ready' ? 'ready' : 'syncing')
        : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : 'offline';
      if (status === 'online' && /^error_/.test(snap.agentDirectoryStatus || '')) phase = 'error';
      if (verifying && status === 'online' && client?.connectionVerification) phase = 'connecting';
      const transport = ['relay', 'directTcp', 'directSocket', 'directPipe', 'remoteSsh'].includes(snap?.activeConnection?.type)
        ? snap.activeConnection.type : 'unknown';
      const rtt = client?.getLastLivenessRttMs?.();
      const previous = rtts.get(host.serverId);
      if (Number.isFinite(rtt) && rtt >= 0 && rtt <= 60000) {
        if (!previous || previous.client !== client || previous.value !== rtt)
          rtts.set(host.serverId, { value: rtt, at: now(), client });
      } else rtts.delete(host.serverId);
      const observed = rtts.get(host.serverId);
      const rawReason = String(client?.getConnectionState?.().reason || snap?.lastError || '').slice(0, 1000).toLowerCase();
      const reason = snap?.authFailureReason || /auth|credential|password|revoked/.test(rawReason) ? 'auth'
        : /^error_/.test(snap?.agentDirectoryStatus || '') ? 'sync'
        : /timed out|timeout/.test(rawReason) ? 'timeout'
        : /network|websocket|transport|connection closed/.test(rawReason) ? 'network'
        : phase === 'error' ? 'unknown' : 'none';
      return { host: slot(host.serverId), selected: host.serverId === selected, phase, transport, reason,
        rttMs: observed ? Math.round(observed.value) : null,
        rttAgeMs: observed ? Math.round(Math.max(0, now() - observed.at)) : null };
    });
  }
  function publish(force = false) {
    if (!store || disposed) return;
    try {
      const hosts = capture();
      // RTT age changes alone do not create a stream of events.
      const key = JSON.stringify(hosts.map(({ rttAgeMs, ...rest }) => rest)) + verifying;
      if (force || key !== lastState) { lastState = key; post('state', { hosts, verifying }); }
    } catch (_) { fail('incompatible'); }
  }
  function changed() {
    if (!flushTimer && !disposed) flushTimer = setTimeout(() => { flushTimer = null; publish(); }, 80);
  }
  function attach() {
    attachTimer = null;
    if (disposed || !active || store) return;
    if (config.webVersion !== '0.12.0') return fail('version');
    try {
      const candidate = window.__paseoHostRuntimeStore;
      if (!candidate) {
        if (now() < attachDeadline) attachTimer = setTimeout(attach, 100);
        else fail('timeout');
        return;
      }
      const methods = ['getHosts', 'getSnapshot', 'getClient', 'subscribeAll', 'subscribeHostList', 'ensureConnectedAll'];
      if (!methods.every(name => typeof candidate[name] === 'function')) return fail('incompatible');
      store = candidate;
      unsubs.push(store.subscribeAll(changed));
      unsubs.push(store.subscribeHostList(changed));
      post('attached'); publish(true);
      if (pendingVerify) { pendingVerify = false; verify(); }
    } catch (_) { fail('incompatible'); }
  }
  function finishVerification() {
    verifying = false; verifyTimer = null;
    post('verification', { busy: false }); publish(true);
  }
  function checkVerification() {
    verifyTimer = null;
    if (!active || !store || disposed) return finishVerification();
    try {
      const pending = store.getHosts().slice(0, 32).some(host => {
        const client = store.getClient(host.serverId);
        return client && (client.connectionVerification || client.getConnectionState?.().status === 'connecting');
      });
      if (pending && now() - verifyStarted < 6000) verifyTimer = setTimeout(checkVerification, 100);
      else finishVerification();
    } catch (_) { fail('incompatible'); }
  }
  function verify() {
    if (!active || !store || verifying || disposed) return false;
    try {
      const clients = store.getHosts().slice(0, 32).map(h => store.getClient(h.serverId)).filter(Boolean);
      if (!clients.every(client => 'connectionVerification' in client && typeof client.getConnectionState === 'function'))
        return fail('incompatible'), false;
      verifying = true; verifyStarted = now(); post('verification', { busy: true });
      // Reuses Paseo's existing transport, verification deduplication and reconnect policy.
      store.ensureConnectedAll({ verify: true }); publish(true);
      verifyTimer = setTimeout(checkVerification, 100);
      return true;
    } catch (_) { fail('incompatible'); return false; }
  }
  function tasks() {
    clearTimeout(taskFlushTimer); taskFlushTimer = null;
    if (taskObserver) taskObserver.disconnect();
    taskObserver = null;
    if (!active || !inspecting || disposed) return;
    const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask');
    post('tasks', { supported: !!supported, count: taskCount, totalMs: Math.round(taskTotal), maxMs: Math.round(taskMax) });
    if (!supported) return;
    try {
      taskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!active || !inspecting || entry.startTime < taskStarted) continue;
          taskCount = Math.min(100000, taskCount + 1);
          taskTotal = Math.min(3600000, taskTotal + Math.min(entry.duration, 60000));
          taskMax = Math.max(taskMax, Math.min(entry.duration, 60000));
        }
        if (!taskFlushTimer) taskFlushTimer = setTimeout(() => {
          taskFlushTimer = null; lastTaskPost = now();
          if (active && inspecting && !disposed)
            post('tasks', { supported: true, count: taskCount, totalMs: Math.round(taskTotal), maxMs: Math.round(taskMax) });
        }, Math.max(0, 1000 - (now() - lastTaskPost)));
      });
      taskObserver.observe({ type: 'longtask', buffered: false });
    } catch (_) { post('tasks', { supported: false, count: 0, totalMs: 0, maxMs: 0 }); }
  }
  let taskStarted = now();
  const api = Object.freeze({
    activate(documentId, nonce) {
      if (disposed || documentId !== doc || generation) return;
      generation = nonce; post('activated');
    },
    foreground(value, shouldVerify = false) {
      if (disposed || !generation) return;
      active = !!value; taskStarted = now();
      clearTimeout(attachTimer); attachTimer = null;
      if (active) {
        if (shouldVerify && !store) pendingVerify = true;
        if (!store) { attachDeadline = now() + 15000; attach(); }
        else if (shouldVerify) verify();
      } else {
        clearTimeout(verifyTimer); verifyTimer = null;
        if (verifying) finishVerification();
      }
      tasks();
    },
    inspect(value, reset = false) {
      inspecting = !!value;
      if (reset) { taskCount = taskTotal = taskMax = 0; taskStarted = now(); }
      tasks(); publish(true);
    },
    refresh() { publish(true); },
    verify,
    dispose() {
      if (disposed) return;
      fail('disposed'); disposed = true;
      slots.clear(); rtts.clear();
    }
  });
  post('hello');
  return api;
})
