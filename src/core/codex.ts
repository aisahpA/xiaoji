import { desktopNode, discoverCodexRuntime, type CodexRuntime } from './codex-runtime';
import type { ChatRequest } from './ai';
import { MemoError } from './types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
function codexFailure(value: unknown): MemoError {
  const error = record(value), message = typeof error.message === 'string' ? error.message : '';
  if (/model_not_found|model[^\n]*(?:not supported|not found|unavailable)/i.test(message)) return new MemoError('codexModelUnavailable');
  if (/usage.?limit|rate.?limit|quota|\b429\b/i.test(message)) return new MemoError('codexLimit');
  if (/\b401\b|unauthori[sz]ed|unauthenticated|not logged in|authentication/i.test(message)) return new MemoError('codexSignIn');
  if (error.code === -32601 || error.code === -32602) return new MemoError('codexProtocol');
  return new MemoError('codexRequestFailed');
}
export interface CodexModel { id: string; name: string; }
export interface CodexInfo { models: CodexModel[]; model: string; runtime?: CodexRuntime; provider?: string; signIn?: 'chatgpt' | 'apiKey' | 'external'; }
interface CodexStream { setEncoding(encoding: 'utf8'): unknown; on(event: 'data', listener: (chunk: string) => void): unknown; }
export interface CodexChild {
  stdin: { write(data: string): unknown; on(event: 'error', listener: () => void): unknown };
  stdout: CodexStream;
  stderr: CodexStream;
  on(event: 'error' | 'exit', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
}
export interface CodexProcess {
  process: CodexChild;
  cleanup(): void;
  runtime?: CodexRuntime;
}
export type CodexLauncher = (executable: string) => CodexProcess | Promise<CodexProcess>;

export const launchCodex: CodexLauncher = async executable => {
  const { childProcess: { spawn }, fs, path, os } = desktopNode();
  const selected = await discoverCodexRuntime(executable);
  const command = selected.path;
  // No vault cwd, project instructions, shell tools, plugins, hooks or remote apps.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-codex-'));
  const config: Record<string, unknown> = {
    sandbox_mode: 'read-only', approval_policy: 'never', web_search: 'disabled',
    'features.shell_tool': false, 'features.unified_exec': false,
    'features.plugins': false, 'features.remote_plugin': false, 'features.apps': false,
    'features.hooks': false, 'features.memories': false, 'features.multi_agent': false,
    'features.multi_agent_v2': false, 'features.browser_use': false, 'features.computer_use': false,
    'features.code_mode': false, 'features.code_mode_host': false, 'features.image_generation': false,
    'tools.view_image': false,
  };
  const args = ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])];
  try {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    return { process: child, runtime: selected, cleanup: () => { try { fs.rmdirSync(cwd); } catch { /* Never recursively remove unexpected files. */ } } };
  } catch (error) { try { fs.rmdirSync(cwd); } catch { /* Empty temp directory only. */ } throw error; }
};

interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: number; }
interface WireMessage { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown; }

/** A single owned stdio connection. Protocol errors fail pending work, never imply success. */
export class CodexClient {
  private child: CodexProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: RecordValue) => void>();
  private nextId = 0;
  private buffer = '';
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: number | undefined;
  private model = '';
  private provider = '';
  private runtimeInfo: CodexRuntime | undefined;
  private threadConfig: RecordValue = {};
  private closed = false;
  private generation = 0;

  constructor(private executable: string, private launcher: CodexLauncher = launchCodex) {}

  private send(message: RecordValue): void {
    if (!this.child) throw new MemoError('codexDisconnected');
    this.child.process.stdin.write(JSON.stringify(message) + '\n');
  }
  private rpc(method: string, params: RecordValue, timeout = 15000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new MemoError('codexTimeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { window.clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new MemoError('codexDisconnected')); }
    });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.disconnect(new MemoError('codexProtocol')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: WireMessage;
      try { message = JSON.parse(line) as WireMessage; if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error(); }
      catch { this.disconnect(new MemoError('codexProtocol')); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          // This assistant never grants command, file, MCP or permission requests.
          this.send({ id: message.id, error: { code: -32601, message: 'Interactive tools are not available in xiaoji.' } });
          continue;
        }
        for (const listener of this.listeners) listener(message.method, record(message.params));
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id); if (!pending) continue;
        window.clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(codexFailure(message.error));
        else if (!('result' in message)) pending.reject(new MemoError('codexProtocol'));
        else pending.resolve(message.result);
      }
    }
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new MemoError('codexDisconnected');
    window.clearTimeout(this.idleTimer);
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      const generation = this.generation;
      const launched = await this.launcher(this.executable);
      launched.process.once('close', () => launched.cleanup());
      if (generation !== this.generation || this.closed) { launched.process.kill(); throw new MemoError('codexDisconnected'); }
      this.child = launched; this.buffer = ''; this.runtimeInfo = launched.runtime;
      const child = launched.process;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data: string) => { if (this.child === launched) this.receive(data); });
      child.stderr.on('data', () => undefined); // Drain logs; never surface credentials or prompt contents.
      const failed = (): void => { if (this.child === launched) this.disconnect(new MemoError('codexDisconnected')); };
      child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed);
      await this.rpc('initialize', { clientInfo: { name: 'xiaoji', title: '小记', version: '0.16.4' } });
      this.send({ method: 'initialized', params: {} });
      const configuration = record(record(await this.rpc('config/read', { includeLayers: false })).config);
      this.model = typeof configuration.model === 'string' ? configuration.model : '';
      this.provider = typeof configuration.model_provider === 'string' ? configuration.model_provider : '';
      this.threadConfig = {};
      // Map replacement is not guaranteed by Codex config merging. Disable each inherited MCP explicitly.
      for (const name of Object.keys(record(configuration.mcp_servers))) this.threadConfig['mcp_servers.' + name + '.enabled'] = false;
    })().catch((error: unknown) => { const failure = error instanceof MemoError ? error : new MemoError('codexDisconnected'); this.disconnect(failure); throw failure; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  private disconnect(error: Error): void {
    this.generation++;
    window.clearTimeout(this.idleTimer);
    const owned = this.child; this.child = null; this.buffer = '';
    for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(error); } this.pending.clear();
    for (const listener of this.listeners) listener('xiaoji/disconnected', { error });
    if (owned) {
      const force = window.setTimeout(() => { try { owned.process.kill('SIGKILL'); } catch { /* Already exited. */ } }, 1500);
      owned.process.once('close', () => window.clearTimeout(force));
      try { owned.process.kill(); } catch { window.clearTimeout(force); }
    }
  }
  private idle(): void { this.idleTimer = window.setTimeout(() => this.disconnect(new MemoError('codexDisconnected')), 60000); }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const job = this.tail.then(action, action); this.tail = job.catch(() => undefined); return job;
  }
  async inspect(): Promise<CodexInfo> {
    return this.exclusive(async () => {
      try {
        if (this.child) this.disconnect(new MemoError('codexDisconnected'));
        await this.connect();
        const account = record(await this.rpc('account/read', { refreshToken: false }));
        if (account.requiresOpenaiAuth === true && !account.account) throw new MemoError('codexSignIn');
        const models: CodexModel[] = []; let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = record(await this.rpc('model/list', { cursor, limit: 100 }));
          if (!Array.isArray(result.data)) throw new MemoError('codexProtocol');
          for (const raw of result.data) { const item = record(raw); if (typeof item.model === 'string' && item.hidden !== true) models.push({ id: item.model, name: typeof item.displayName === 'string' ? item.displayName : item.model }); }
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor) break;
        }
        const type = record(account.account).type;
        return { models, model: this.model, runtime: this.runtimeInfo, provider: this.provider || 'openai', signIn: type === 'chatgpt' ? 'chatgpt' : type === 'apiKey' ? 'apiKey' : 'external' };
      } finally { this.idle(); }
    });
  }
  complete(request: ChatRequest, signal: AbortSignal, onChunk: (text: string) => void): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError());
    const job = this.exclusive(() => this.run(request, signal, onChunk));
    // A queued, cancelled request returns immediately and will not start a later turn.
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(abortError()); signal.addEventListener('abort', abort, { once: true });
      void job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  private async run(request: ChatRequest, signal: AbortSignal, onChunk: (text: string) => void): Promise<string> {
    signal.throwIfAborted();
    let threadId = '';
    const abort = (): void => this.disconnect(abortError());
    signal.addEventListener('abort', abort, { once: true });
    let off = (): void => undefined;
    try {
      await this.connect(); signal.throwIfAborted();
      const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      const started = record(await this.rpc('thread/start', {
        model: request.model || undefined, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: this.threadConfig,
        baseInstructions: 'You are the text assistant inside xiaoji. Respond only in text using the supplied context. Do not run commands, read files, invoke tools or change anything.\n\n' + system,
      }));
      const thread = record(started.thread);
      if (typeof thread.id !== 'string' || !thread.id) throw new MemoError('codexProtocol');
      threadId = thread.id;
      let settle!: (text: string) => void, fail!: (error: unknown) => void;
      const completion = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
      const parts = new Map<string, string>();
      const phases = new Map<string, unknown>();
      const answer = (): string => [...parts].filter(([id]) => phases.get(id) !== 'commentary').map(([, text]) => text).join('\n\n');
      const receive = (method: string, params: RecordValue): void => {
        if (method === 'xiaoji/disconnected') { fail(signal.aborted ? abortError() : params.error instanceof Error ? params.error : new MemoError('codexDisconnected')); return; }
        if (params.threadId !== threadId) return;
        if (method === 'item/started') {
          const item = record(params.item); if (item.type === 'agentMessage' && typeof item.id === 'string') phases.set(item.id, item.phase);
        } else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId === 'string') {
          const id = params.itemId; parts.set(id, (parts.get(id) ?? '') + params.delta); onChunk(answer());
        } else if (method === 'item/completed') {
          const item = record(params.item);
          if (item.type === 'agentMessage' && typeof item.text === 'string' && typeof item.id === 'string') { phases.set(item.id, item.phase); parts.set(item.id, item.text); onChunk(answer()); }
        } else if (method === 'turn/completed') {
          const turn = record(params.turn);
          if (turn.status === 'completed' && answer().trim()) settle(answer());
          else fail(turn.status === 'completed' ? new MemoError('aiEmpty') : codexFailure(turn.error));
        }
      };
      this.listeners.add(receive); off = () => this.listeners.delete(receive);
      // Attach rejection handling before starting; a child exit can precede the start response.
      void completion.catch(() => undefined);
      const context = request.messages.filter(message => message.role !== 'system');
      const turn = record(await this.rpc('turn/start', { threadId, input: [{ type: 'text', text: JSON.stringify(context), text_elements: [] }] }, 30000));
      if (!record(turn.turn).id) throw new MemoError('codexProtocol');
      const result = await completion; signal.throwIfAborted(); return result;
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error instanceof MemoError ? error : new MemoError('codexRequestFailed');
    } finally {
      off(); signal.removeEventListener('abort', abort);
      if (threadId && this.child) await this.rpc('thread/unsubscribe', { threadId }, 3000).catch(() => this.disconnect(new MemoError('codexDisconnected')));
      this.idle();
    }
  }
  dispose(): void { this.closed = true; this.disconnect(new MemoError('codexDisconnected')); }
}
