// Native Paseo keeps its existing file download owner.
export async function tryAccessDownload(_input: {
  serverId: string;
  token: string;
  filename: string;
}): Promise<boolean> {
  return false;
}
