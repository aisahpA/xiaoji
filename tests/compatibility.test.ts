import { describe, expect, it } from 'vitest';
import { contentFromResponse, readSse } from '../src/core/ai';
import { secretStore } from '../src/core/secret-store';
import { normalizeFolder, safeFileName } from '../src/core/settings';

describe('host compatibility and external response boundaries', () => {
  it('keeps old hosts without secret storage supported', () => {
    for (const host of [{}, { secretStorage: null }, { secretStorage: { getSecret: true } }]) expect(secretStore(host)).toBeNull();
  });
  it('preserves method receivers and rejects non-string secrets', () => {
    const storage = { value: 'original', getSecret() { return this.value; }, setSecret(_name: string, value: string) { this.value = value; } };
    const store = secretStore({ secretStorage: storage })!;
    expect(store.getSecret('key')).toBe('original'); store.setSecret('key', 'updated'); expect(storage.value).toBe('updated');
    expect(secretStore({ secretStorage: { getSecret: () => 42, setSecret() {} } })!.getSecret('key')).toBeNull();
  });
  it.each([null, [], { choices: {} }, { choices: [null] }, { choices: [{ message: { content: 42 } }] }])('rejects malformed non-streaming responses: %j', value => {
    expect(() => contentFromResponse(value)).toThrow();
  });
  it.each(['null', '[]', '{"choices":{}}', '{"choices":[null]}', '{"choices":[{"delta":42}]}'])('rejects malformed SSE data: %s', async payload => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + payload + '\n\n')); controller.close(); } });
    const read = async () => { for await (const text of readSse(stream, new AbortController().signal)) void text; };
    await expect(read()).rejects.toThrow();
  });
  it('continues accepting usage-only SSE events and empty choices', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n')); controller.close(); } });
    let result = ''; for await (const text of readSse(stream, new AbortController().signal)) result += text;
    expect(result).toBe('你好');
  });
  it('continues rejecting every control character in paths', () => {
    for (let code = 0; code < 32; code++) {
      expect(() => normalizeFolder('目录/' + String.fromCharCode(code) + '文件')).toThrow();
      expect(() => safeFileName('文件' + String.fromCharCode(code) + '.md')).toThrow();
    }
    expect(normalizeFolder('小记/AI')).toBe('小记/AI');
  });
});
