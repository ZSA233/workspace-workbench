export type FileLocation = { workspaceId: string; instance?: string; path: string };
const sameWorkspace = (a: FileLocation, b: FileLocation) => a.workspaceId === b.workspaceId && (!a.instance || !b.instance || a.instance === b.instance);
export function unchangedFileMove(source: FileLocation, destination: FileLocation) {
  const parent = source.path.includes('/') ? source.path.slice(0, source.path.lastIndexOf('/')) : '';
  return Boolean(source.path) && sameWorkspace(source, destination) && parent === destination.path;
}
export function destinationInsideSource(source: FileLocation, destination: FileLocation) {
  return Boolean(source.path) && sameWorkspace(source, destination) && (destination.path === source.path || destination.path.startsWith(source.path + '/'));
}
