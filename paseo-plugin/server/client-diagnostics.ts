import type { z } from "zod";
import type { clientDiagnostic } from "../shared/client-diagnostics";

type ClientDiagnostic = z.output<typeof clientDiagnostic.input> & { at: string };
const retained: ClientDiagnostic[] = [];
const MAX_RETAINED = 100;

export function handleClientDiagnostic(input: z.output<typeof clientDiagnostic.input>): z.input<typeof clientDiagnostic.output> {
  const event = { ...input, at: new Date().toISOString() };
  retained.push(event);
  while (retained.length > MAX_RETAINED) retained.shift();
  console.error("workbench_client_diagnostic", JSON.stringify(event));
  return { ok: true, retained: retained.length };
}

export function clientDiagnosticsSnapshot(): ClientDiagnostic[] {
  return retained.slice();
}
