/** Shared control-plane envelope; execution, persistence and cancellation stay with owners. */
export function taskIdentity(id: string, generation: string, state: string, phase: string, acceptedAt: number) {
    return { protocol: 1, taskId: id, generation, state, phase, acceptedAt };
}
export function uncertainControlFailure(code: string | undefined): boolean {
    return ['request_uncertain_retry_same_identity', 'observer_timeout', 'observer_unavailable', 'observer_busy', 'backend_unavailable_before_dispatch', 'observer_connection_refused', 'observer_socket_error'].includes(code || '');
}
