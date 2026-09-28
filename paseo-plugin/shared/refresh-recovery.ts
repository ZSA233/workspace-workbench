/** Only read failures with a known transient meaning may be retried automatically. */
const retryable = new Set([
  'observer_timeout', 'observation_timeout', 'git_timeout', 'observer_refresh_timeout',
  'observer_unavailable', 'observer_busy', 'observer_connection_refused',
  'observer_socket_error', 'observer_cancelled', 'observation_superseded',
  'diff_task_missing', 'observer_closed', 'observer_closing',
]);
export function refreshRetryable(code: string): boolean { return retryable.has(code); }
