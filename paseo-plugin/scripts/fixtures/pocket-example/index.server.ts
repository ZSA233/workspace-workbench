import { examplePing } from './shared/protocol';
export default function contribute(server: any) {
  server.handle(examplePing, ({ workspaceId, panel }: { workspaceId: string; panel: number }) => ({ plugin: 'pocket-example', workspaceId, panel }));
  return () => {};
}
