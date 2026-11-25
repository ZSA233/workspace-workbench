import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import type {TopicVideoPreview} from '../shared/topic-video.ts';
import {MAX_VIDEO_BYTES} from '../shared/artifact-limits.ts';

const cache = new Map<string, TopicVideoPreview>();
const waiting: Array<() => void> = [];
let running = 0;
function executable(name: string) {
  // A daemon launched by launchd often has a minimal PATH.
  const directories = [...(process.env.PATH || '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean);
  const path = directories.map(directory => join(directory, process.platform === 'win32' ? name + '.exe' : name)).find(existsSync);
  if (!path) throw Error('topic_video_tools_unavailable');
  return path;
}

/** Owned, bounded decoding. Untrusted clips cannot fetch network resources. */
function run(command: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(Error('extension_host_unloaded'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true});
    const chunks: Buffer[] = []; let length = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const abort = () => stop(Error('extension_host_unloaded'));
    const timer = setTimeout(() => stop(Error('topic_video_decode_timeout')), 15000);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.stdout.on('data', (bytes: Buffer) => { length += bytes.length; if (length > 512 * 1024) stop(Error('topic_video_frame_too_large')); else chunks.push(bytes); });
    let errors = 0;
    child.stderr.on('data', (bytes: Buffer) => { errors += bytes.length; if (errors > 64 * 1024) stop(Error('topic_video_decode_failed')); });
    const cleanup = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort);};
    child.once('error', () => {cleanup(); reject(Error('topic_video_tools_unavailable'));});
    child.once('close', code => {cleanup(); if (failure) reject(failure); else if (code !== 0) reject(Error('topic_video_decode_failed')); else resolve(Buffer.concat(chunks));});
  });
}

export async function prepareTopicVideo(bytes: Buffer, signal?: AbortSignal): Promise<TopicVideoPreview> {
  if (signal?.aborted) throw Error('extension_host_unloaded');
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throw Error('artifact_size_exceeded');
  const key = createHash('sha256').update(bytes).digest('hex');
  if (cache.has(key)) return cache.get(key)!;
  if (running >= 2) {
    if (waiting.length >= 20) throw Error('topic_video_busy');
    await new Promise<void>((resolve, reject) => {
      const resume = () => {signal?.removeEventListener('abort', abort); resolve();};
      const abort = () => {const index = waiting.indexOf(resume); if (index >= 0) waiting.splice(index, 1); reject(Error('extension_host_unloaded'));};
      waiting.push(resume); signal?.addEventListener('abort', abort, {once:true}); if (signal?.aborted) abort();
    });
  } else running++;
  let root: string | undefined;
  try {
    if (signal?.aborted) throw Error('extension_host_unloaded');
    if (cache.has(key)) return cache.get(key)!;
    const ffmpeg = executable('ffmpeg'), ffprobe = executable('ffprobe');
    root = mkdtempSync(join(tmpdir(), 'workbench-topic-video-'));
    const file = join(root, 'original'); writeFileSync(file, bytes, {mode:0o600});
    const raw = await run(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-show_entries','format=duration:stream=codec_type,width,height,avg_frame_rate','-of','json',file], signal);
    const metadata = JSON.parse(raw.toString('utf8'));
    const duration = Number(metadata.format?.duration);
    const stream = metadata.streams?.find((item: {codec_type:string}) => item.codec_type === 'video');
    if (!Number.isFinite(duration) || duration <= 0 || !stream || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 3840 * 2160) throw Error('topic_video_decode_failed');
    const [numerator,denominator]=String(stream.avg_frame_rate||'').split('/').map(Number),rate=numerator/denominator;
    const last=Math.max(0,duration-(Number.isFinite(rate)&&rate>0?Math.max(0.1,1/rate):Math.min(1,duration/4)));
    const result: TopicVideoPreview = {duration, frames:[]};
    for (const fraction of [0, 1 / 3, 2 / 3, 0.95]) {
      const time = Math.min(last, duration * fraction);
      if (result.frames.some(frame => Math.abs(frame.time - time) < 0.1)) continue;
      const frame = await run(ffmpeg, ['-v','error','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-ss',time.toFixed(3),'-i',file,
        '-map','0:v:0','-frames:v','1','-an','-vf',"scale=960:960:force_original_aspect_ratio=decrease",'-threads','1','-q:v','5','-f','image2pipe','-c:v','mjpeg','-pix_fmt','yuvj420p','pipe:1'], signal);
      if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) throw Error('topic_video_decode_failed');
      result.frames.push({time, mimeType:'image/jpeg', base64:frame.toString('base64')});
    }
    cache.set(key, result); while (cache.size > 6) cache.delete(cache.keys().next().value!);
    return result;
  } finally {if (root) rmSync(root, {recursive:true, force:true}); const next=waiting.shift(); if(next)next();else running--;}
}

/** Original delivery remains available when optional decoding cannot produce frames. */
export async function topicVideoPreview(bytes: Buffer, signal?: AbortSignal, timeoutMs = 8000): Promise<TopicVideoPreview> {
  if (signal?.aborted) throw Error('extension_host_unloaded');
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) throw Error('artifact_size_exceeded');
  if (timeoutMs <= 0) return { duration: 0, frames: [], size: bytes.length, error: 'topic_video_decode_timeout' };
  const decoding = new AbortController(), cancel = () => decoding.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try { return { ...await prepareTopicVideo(bytes, decoding.signal), size: bytes.length }; }
  catch (error) {
    const code = timedOut ? 'topic_video_decode_timeout' : error instanceof Error ? error.message : '';
    if (signal?.aborted || !/^topic_video_(tools_unavailable|decode_failed|decode_timeout|frame_too_large|busy)$/.test(code)) throw error;
    return { duration: 0, frames: [], size: bytes.length, error: code };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
