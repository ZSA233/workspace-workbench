export function normalizePaseoEndpoint(value) {
    const target = String(value || "").replace(/^unix:\/\//, "");
    if (target.startsWith("/")) return `ws+unix://${target}:/ws`;
    const local = target.match(/^(127\.0\.0\.1|localhost):(\d{1,5})$/);
    if (local && Number(local[2]) > 0 && Number(local[2]) <= 65_535) return `ws://${local[1]}:${local[2]}/ws`;
    // Paseo commonly binds the daemon to all local interfaces. The plugin
    // runs on the same machine, so resolve wildcard listeners through the
    // loopback address without ever accepting an arbitrary remote host.
    const wildcard = target.match(/^(?:0\.0\.0\.0|\*):(\d{1,5})$/);
    if (wildcard && Number(wildcard[1]) > 0 && Number(wildcard[1]) <= 65_535) return `ws://127.0.0.1:${wildcard[1]}/ws`;
    const ipv6Local = target.match(/^\[(::1)\]:(\d{1,5})$/);
    if (ipv6Local && Number(ipv6Local[2]) > 0 && Number(ipv6Local[2]) <= 65_535) return `ws://[${ipv6Local[1]}]:${ipv6Local[2]}/ws`;
    const ipv6Wildcard = target.match(/^\[(?:::|0:0:0:0:0:0:0:0)\]:(\d{1,5})$/);
    if (ipv6Wildcard && Number(ipv6Wildcard[1]) > 0 && Number(ipv6Wildcard[1]) <= 65_535) return `ws://localhost:${ipv6Wildcard[1]}/ws`;
  return "";
}
