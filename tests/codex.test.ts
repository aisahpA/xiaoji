import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexClient, type CodexLauncher } from '../src/core/codex';
import { createAIBackend } from '../src/ui/ai-backend';
import { loadSettings } from '../src/core/settings';
import type { ChatRequest } from '../src/core/ai';

const clients: CodexClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); });
const request: ChatRequest = { model: '', stream: true, messages: [{ role: 'system', content: 'Use only supplied sources.' }, { role: 'user', content: '你好' }] };
const setup = (mode: 'ok' | 'failed' | 'hang' | 'exit' | 'malformed' | 'modelUnavailable' | 'commentary' = 'ok') => {
  const messages: Record<string, any>[] = [];
  const spawned: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn> })[] = [];
  const launcher: CodexLauncher = vi.fn(() => {
    const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as unknown as Writable, kill: vi.fn() });
    const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
    process.stdin = new Writable({ write(chunk, _encoding, callback) {
      const value = JSON.parse(String(chunk)) as Record<string, any>; messages.push(value); callback();
      queueMicrotask(() => {
        if (!value.method || value.id === undefined) return;
        let result: unknown = {};
        if (value.method === 'config/read') result = { config: { model: 'local-default', mcp_servers: { personal: { command: 'never-run' } } } };
        if (value.method === 'account/read') result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
        if (value.method === 'model/list') result = { data: [{ model: 'local-default', displayName: 'Local default' }], nextCursor: null };
        if (value.method === 'thread/start') result = { thread: { id: 'thread-1' } };
        if (value.method === 'turn/start') result = { turn: { id: 'turn-1' } };
        emit({ id: value.id, result });
        if (value.method !== 'turn/start') return;
        if (mode === 'exit') { process.emit('exit', 1); return; }
        if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
        if (mode === 'hang') return;
        if (mode === 'commentary') {
          emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'progress', phase: 'commentary' } } });
          emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'progress', delta: 'Working on it' } });
          emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Working on it' } } });
        }
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'different-thread', itemId: 'bad', delta: 'leak' } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'answer', delta: '你好🙂' } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'answer', text: '你好🙂，来自本机。' } } });
        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: mode === 'failed' || mode === 'modelUnavailable' ? 'failed' : 'completed', ...(mode === 'modelUnavailable' ? { error: { message: 'The model is not supported. model_not_found' } } : {}) } } });
      });
    } });
    process.kill.mockImplementation(() => { queueMicrotask(() => { process.emit('exit', 0); process.emit('close', 0); }); return true; });
    spawned.push(process);
    return { process: process as unknown as ChildProcessWithoutNullStreams, cleanup: vi.fn() };
  });
  const client = new CodexClient('', launcher); clients.push(client);
  return { client, launcher, messages, spawned };
};
describe('local Codex protocol', () => {
  it('checks the connection and catalog without sending a user turn', async () => {
    const { client, messages } = setup();
    expect(await client.inspect()).toMatchObject({ model: 'local-default', models: [{ id: 'local-default', name: 'Local default' }], signIn: 'chatgpt', provider: 'openai' });
    expect(messages.some(message => message.method === 'turn/start')).toBe(false);
    expect(messages[0]!.method).toBe('initialize');
  });
  it('uses isolated ephemeral read-only threads and only accepts the matching stream', async () => {
    const { client, messages, launcher } = setup(); const chunks: string[] = [];
    expect(await client.complete(request, new AbortController().signal, text => chunks.push(text))).toBe('你好🙂，来自本机。');
    expect(chunks).toEqual(['你好🙂', '你好🙂，来自本机。']);
    const start = messages.find(message => message.method === 'thread/start')!;
    expect(start.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: { 'mcp_servers.personal.enabled': false } });
    expect(start.params.model).toBeUndefined();
    expect(messages.at(-1)!.method).toBe('thread/unsubscribe');
    await client.complete(request, new AbortController().signal, () => undefined); expect(launcher).toHaveBeenCalledTimes(1);
  });
  it('does not treat partial output from a failed turn as a successful answer', async () => {
    const { client } = setup('failed'); await expect(client.complete(request, new AbortController().signal, () => undefined)).rejects.toThrow('codexRequestFailed');
  });
  it('reports an unavailable model with an actionable error', async () => {
    const { client } = setup('modelUnavailable'); await expect(client.complete(request, new AbortController().signal, () => undefined)).rejects.toThrow('codexModelUnavailable');
  });
  it('keeps progress commentary out of the final assistant answer', async () => {
    const { client } = setup('commentary'); expect(await client.complete(request, new AbortController().signal, () => undefined)).toBe('你好🙂，来自本机。');
  });
  it.each(['exit', 'malformed'] as const)('rejects %s promptly instead of hanging', async mode => {
    const { client } = setup(mode);
    await expect(client.complete(request, new AbortController().signal, () => undefined)).rejects.toThrow(mode === 'exit' ? 'codexDisconnected' : 'codexProtocol');
  });
  it('cancels a running process and skips an already cancelled queued request', async () => {
    const { client, spawned, messages } = setup('hang'); const active = new AbortController(), queued = new AbortController();
    const first = client.complete(request, active.signal, () => undefined); const firstCheck = expect(first).rejects.toHaveProperty('name', 'AbortError');
    const second = client.complete(request, queued.signal, () => undefined); const secondCheck = expect(second).rejects.toHaveProperty('name', 'AbortError');
    queued.abort(); await secondCheck;
    await vi.waitFor(() => expect(messages.some(message => message.method === 'turn/start')).toBe(true));
    active.abort(); await firstCheck; expect(spawned[0]!.kill).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(1);
  });
  it('keeps API settings and validates them independently of the Codex backend', () => {
    const { client } = setup(); const settings = loadSettings({ aiProvider: 'codex', codexModel: 'local-model' });
    expect(createAIBackend(settings, '', client).model).toBe('local-model');
    expect(() => createAIBackend({ ...settings, aiProvider: 'api' }, '')).toThrow('aiNotConfigured');
    expect(() => createAIBackend(settings, '')).toThrow('codexDesktopOnly');
  });
});
