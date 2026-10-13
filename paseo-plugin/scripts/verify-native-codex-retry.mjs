/** Actual Codex app-server, isolated home and loopback-only Responses fixture. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-native-codex-')));
const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
const home = join(root, 'isolated-home'); mkdirSync(home, { recursive: true });
const requests = [], events = [], pending = new Map();
let nextId = 1, stderr = '';
const server = createServer(async (req, res) => {
  let raw = ''; for await (const data of req) raw += data;
  let body; try { body = JSON.parse(raw); } catch { body = {}; }
  requests.push({ path: req.url, input: body.input, model: body.model });
  if (requests.length >= 2) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'message', id: `msg-${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({ type: 'response.created', response: { id: `resp-${requests.length}`, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' });
    event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { id: `resp-${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } });
    res.end(); return;
  }
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Selected model is at capacity.', type: 'server_error', code: 'server_is_overloaded' } }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
writeFileSync(join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "local_retry_probe"\n[model_providers.local_retry_probe]\nname = "Local retry probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
const env = { ...process.env, CODEX_HOME: home };
for (const key of ['OPENAI_API_KEY','CODEX_API_KEY','ACCESS_TOKEN','OPENAI_BASE_URL']) delete env[key];
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', b => { stderr += b; });
createInterface({ input: child.stdout }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  else if (message.method) events.push(message);
});
const send = async (method, params) => {
  const id = nextId++;
  let timer;
  try { return await Promise.race([new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`timeout ${method}`)), 15000); })]); }
  finally { clearTimeout(timer); pending.delete(id); }
};
const wait = async check => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = check(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
  throw Error('event timeout');
};
try {
  const init = await send('initialize', { clientInfo: { name: 'local_retry_probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  if (init.error) throw Error(JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const thread = await send('thread/start', { model: 'gpt-5.4', modelProvider: 'local_retry_probe', cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
  if (thread.error) throw Error(JSON.stringify(thread.error));
  const threadId = thread.result.thread.id;
  const first = await send('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with OK.', text_elements: [] }] });
  if (first.error) throw Error(JSON.stringify(first.error));
  const firstEnd = await wait(() => events.find(e => e.method === 'turn/completed' && e.params.turn.id === first.result.turn.id));
  const before = requests.length;
  const empty = await send('turn/start', { threadId, input: [] });
  await new Promise(r => setTimeout(r, 1000));
  const emptyEnd = events.find(e => e.method === 'turn/completed' && e.params.turn.id === empty.result?.turn?.id);
  const afterEmpty = await send('thread/read', { threadId, includeTurns: true });
  const userMessagesAfterEmpty = afterEmpty.result?.thread?.turns?.flatMap(t => t.items || []).filter(i => i.type === 'userMessage');
  const blankText = await send('turn/start', { threadId, input: [{ type: 'text', text: '', text_elements: [] }] });
  await new Promise(r => setTimeout(r, 1000));
  const blankEnd = events.find(e => e.method === 'turn/completed' && e.params.turn.id === blankText.result?.turn?.id);
  const history = await send('thread/read', { threadId, includeTurns: true });
  const userMessages = history.result?.thread?.turns?.flatMap(t => t.items || []).filter(i => i.type === 'userMessage');
  const report = { root, codexVersion, evidence: 'Actual Codex app-server with an isolated CODEX_HOME and a loopback Responses fixture; no real model calls', firstStatus: firstEnd.params.turn.status, requestsBeforeEmpty: before, empty, emptyStatus: emptyEnd?.params.turn.status, sameModelInputAfterEmpty: JSON.stringify(requests[0]?.input) === JSON.stringify(requests[1]?.input), userMessagesAfterEmpty, blankText, blankStatus: blankEnd?.params.turn.status, requestsAfterRetries: requests.length, userMessages };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(root, 'wire-requests.json'), JSON.stringify(requests, null, 2));
  if (report.firstStatus !== 'failed' || report.emptyStatus !== 'completed' || !report.sameModelInputAfterEmpty || report.userMessagesAfterEmpty.length !== 1 || report.userMessages.length !== 2) throw Error('native_retry_history_invariant_failed');
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.log(JSON.stringify({ error: error.message, stderr: stderr.slice(-3500) })); process.exitCode = 1; }
finally { child.kill('SIGTERM'); await new Promise(r => server.close(r)); }
