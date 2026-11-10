// Optional HTTP adapter. No Android object, credentials, or host URLs enter here.
const prefix = '/__access/paseo';
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function tryAccessDownload(url: string, serverId: string, filename: string, web: any = globalThis): Promise<boolean> {
  if (!web.location?.href || !web.document || !web.fetch) return false;
  const source = new web.URL(url, web.location.href);
  if (source.origin !== web.location.origin || source.pathname !== '/api/files/download' || source.username || source.password || source.hash || [...source.searchParams.keys()].some(k => k !== 'token') || source.searchParams.getAll('token').length !== 1) throw new Error('Invalid host download URL');
  const token = source.searchParams.get('token');
  if (!token || !tokenPattern.test(token)) throw new Error('Invalid host download token');
  const capability = await web.fetch(prefix + '/capabilities', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (capability.status === 404 || capability.status === 405) return false;
  if (capability.status === 401 || capability.status === 403) throw new Error('请重新打开工作台完成登录，再下载文件');
  if (!capability.ok) throw new Error('下载入口暂时不可用');
  const caps = await capability.json();
  if (caps.download_handoff_version !== 1 || typeof caps.entry_server_id !== 'string') return false;
  const ua = web.navigator?.userAgent || '';
  const native = /\bAccessPocket\/(\d+)\.(\d+)\.(\d+)/.exec(ua);
  if (native && Number(native[1]) === 0 && (Number(native[2]) < 2 || Number(native[2]) === 2 && Number(native[3]) < 9) || !native && /; wv\)/.test(ua)) throw new Error('请更新 Access Pocket 后再保存文件');
  const result = await web.fetch(prefix + '/downloads', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server_id: serverId, token, filename, transport: native ? 'native' : 'browser' }),
  });
  if (!result.ok) throw new Error(result.status === 429 ? '当前下载较多，请稍后重试' : '下载未能开始，请重新下载');
  const value = await result.json();
  if (typeof value.download_url !== 'string') throw new Error('Invalid download handoff');
  const next = new web.URL(value.download_url, web.location.href);
  const suffix = native ? 'start' : 'content';
  if (next.origin !== web.location.origin || next.username || next.password || next.hash || next.search || !new RegExp('^' + prefix + '/downloads/[a-f0-9]{64}/' + suffix + '$').test(next.pathname)) throw new Error('Invalid download handoff');
  const link = web.document.createElement('a'); link.href = next.href; link.download = filename; link.rel = 'noopener noreferrer';
  web.document.body.appendChild(link); link.click(); link.remove();
  return true;
}
