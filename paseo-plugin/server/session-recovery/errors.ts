export type RecoveryFailure = { message: string; code?: string; codexErrorInfo?: unknown; willRetry?: boolean };
export function recoverableFailure(error: RecoveryFailure): boolean {
  if (error.willRetry) return false;
  const info = error.codexErrorInfo;
  const code = `${error.code || ""} ${typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info).join(" ") : ""}`;
  const text = `${code} ${error.message}`;
  // These require a user decision. They take precedence over generic HTTP/stream wording.
  if (/usage.?limit|session.?budget.?exceeded|context.?window.?exceeded|quota|billing|credit|unauthori[sz]ed|authentication|invalid.?api.?key|permission.?denied|sandbox|cyber.?policy|misalignment|denial|bad.?request|request too large|context.{0,20}(?:length|limit)|cancelled|canceled|interrupted/i.test(text)) return false;
  if (/server.?overloaded|server_is_overloaded|selected model is at capacity|model.{0,20}(?:overloaded|at capacity)|flex.?unavailable|flex capacity unavailable/i.test(text)) return true;
  if (/rate.?limit.?exceeded|rate limit reached|too many requests|\bslow_down\b/i.test(text)) return true;
  if (/response.?stream.?disconnected|response.?stream.?connection.?failed|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|stream disconnected before completion|connection (?:reset|closed|timed out)|websocket.{0,40}(?:closed|disconnected|connection failed)|error sending request for url|network connection.{0,20}(?:lost|failed)/i.test(text)) return true;
  if (/http.?connection.?failed/i.test(code) && info && typeof info === "object") {
    const detail = (info as Record<string, { httpStatusCode?: number }>).httpConnectionFailed;
    return [408, 502, 503, 504].includes(detail?.httpStatusCode || 0);
  }
  // "Retry limit exceeded" alone says nothing about whether retrying is appropriate.
  return /(?:last status|HTTP(?: status)?)[ :]+(?:408|502|503|504)\b/i.test(error.message);
}
