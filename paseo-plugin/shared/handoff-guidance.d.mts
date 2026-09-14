export const coordinatorGuidance: string;
export const handoffCompleteGuidance: string;
export function handoffOutcome<T>(result: T): T & { nextAction: string; instructions: string };
