export const reportKey = (agentId: string) => `agent-review:execution-report:${agentId}`;
export const turnKey = (agentId: string, turnId: string) => `agent-review:turn:${agentId}:${turnId}`;
export const authKey = (sessionId: string) => `agent-review:auth:${sessionId}`;
export function errorInfo(error: unknown, fallback = "Agent Review is unavailable"): {
    code: string;
    message: string;
} {
    if (error instanceof Error) {
        const code = typeof (error as Error & {
            code?: unknown;
        }).code === "string" ? String((error as Error & {
            code?: unknown;
        }).code) : error.message;
        return { code: code || "review_failed", message: error.message || fallback };
    }
    return { code: "review_failed", message: fallback };
}
