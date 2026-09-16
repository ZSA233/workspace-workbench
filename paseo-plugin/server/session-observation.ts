import { randomUUID } from 'node:crypto';
import { currentProject } from './projects.ts';
const epoch = randomUUID(), revisions = new Map<string, number>();
export function sessionChanged() {
  const key = currentProject()?.configPath || '';
  revisions.set(key, (revisions.get(key) || 0) + 1);
}
export function sessionRevision() { return `${epoch}:${revisions.get(currentProject()?.configPath || '') || 0}`; }
