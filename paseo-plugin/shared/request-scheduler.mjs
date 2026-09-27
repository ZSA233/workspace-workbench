/** Transport-independent admission, deadlines and single-response ownership. */
export function createRequestScheduler({
  concurrency = 4, queueLimit = 16, controlConcurrency = 2,
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  const records = new Map();
  const lanes = {
    business: { active: 0, limit: concurrency, queue: [] },
    control: { active: 0, limit: controlConcurrency, queue: [] },
  };
  let closed = false;

  function finish(record, error, value) {
    if (record.responded) return;
    record.responded = true;
    record.respond(error, value);
  }

  function cancel(id, reason = 'cancelled') {
    const record = records.get(id);
    if (!record || record.responded) return;
    const queued = !record.started;
    const prefix = record.dispatched
      ? 'workbench_request_uncertain_retry_same_identity' : 'workbench_not_dispatched';
    const code = queued && reason === 'deadline' ? 'queue_timeout' : reason;
    const error = Object.assign(new Error(`${prefix}:${code}`), {
      workbenchDispatched: record.dispatched,
      stage: queued ? 'queue' : record.phase,
      queueMs: (record.startedAt ?? now()) - record.receivedAt,
    });
    record.controller.abort(reason);
    finish(record, error);
    if (queued) {
      record.lane.queue.splice(record.lane.queue.indexOf(record), 1);
      unschedule(record.timer);
      records.delete(id);
    }
  }

  function drain(lane) {
    while (!closed && lane.active < lane.limit && lane.queue.length) {
      const record = lane.queue[0];
      if (now() >= record.deadline) { cancel(record.id, 'deadline'); continue; }
      lane.queue.shift();
      lane.active++;
      record.started = true;
      record.startedAt = now();
      record.phase = 'connecting';
      Promise.resolve().then(() => {
        if (record.controller.signal.aborted) throw new Error('cancelled');
        return record.run({
          signal: record.controller.signal,
          deadline: record.deadline,
          diagnose: event => {
            if (event.phase === 'rpc') record.dispatched = true;
            record.phase = event.phase;
            record.diagnose?.({ ...event,
              queueMs: record.startedAt - record.receivedAt, dispatched: record.dispatched });
          },
        });
      }).then(value => finish(record, null, value), error => finish(record, error))
        .finally(() => {
          // A response timeout does not release capacity until owned cleanup
          // finishes. A late result cannot send a second response.
          unschedule(record.timer);
          records.delete(record.id);
          lane.active--;
          drain(lane);
        });
    }
  }

  return {
    submit({ id, run, respond, deadline, control = false, diagnose }) {
      const lane = control ? lanes.control : lanes.business;
      if (closed || records.has(id) || lane.active >= lane.limit && lane.queue.length >= queueLimit) {
        respond(new Error(records.has(id) ? 'duplicate_request_id' : 'workbench_busy_not_dispatched'));
        return;
      }
      const record = { id, run, respond, diagnose, deadline, receivedAt: now(), lane,
        controller: new AbortController(), responded: false, started: false, dispatched: false, phase: 'queued' };
      records.set(id, record);
      lane.queue.push(record);
      record.timer = schedule(() => cancel(id, 'deadline'), Math.max(0, deadline - now()));
      drain(lane);
    },
    cancel,
    close() {
      closed = true;
      for (const id of records.keys()) cancel(id, 'shutdown');
    },
    health() {
      return { active: lanes.business.active + lanes.control.active,
        queued: lanes.business.queue.length + lanes.control.queue.length };
    },
  };
}
