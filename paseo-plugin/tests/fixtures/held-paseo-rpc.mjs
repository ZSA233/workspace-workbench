// Loaded only by the HTTP transport test child, never by the shipped gateway.
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
const pending = new Set();
DaemonClient.prototype.connect = async function () {};
DaemonClient.prototype.close = async function () {};
DaemonClient.prototype.invokePluginRpc = function () {
  process.send?.({ event: 'rpc-held' });
  return new Promise(resolve => pending.add(resolve));
};
process.on('message', message => {
  if (message === 'release-rpc') {
    for (const resolve of pending) resolve({ok:true});
    pending.clear();
  }
});
