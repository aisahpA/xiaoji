import { requestUrl } from 'obsidian';
import { contentFromResponse, readSse, type ChatRequest } from '../core/ai';
import { MemoError } from '../core/types';

/** Abort UI work even if the host's non-streaming bridge cannot cancel the server request. */
export async function complete(
  endpoint: string, key: string, request: ChatRequest, signal: AbortSignal,
  onChunk: (text: string) => void, onBridge: () => void,
): Promise<string> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      credentials: 'omit', signal, body: JSON.stringify(request),
    });
  } catch (error) {
    if (signal.aborted || !(error instanceof TypeError)) throw error;
    onBridge();
    const pending = requestUrl({ url: endpoint, method: 'POST', throw: false,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ ...request, stream: false }) });
    let abort: () => void = () => undefined;
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const host = await Promise.race([pending, cancellation]);
      signal.throwIfAborted();
      if (host.status < 200 || host.status >= 300) throw new MemoError('aiHttpError', String(host.status));
      return contentFromResponse(host.json);
    } finally { signal.removeEventListener('abort', abort); }
  }
  if (!response.ok) throw new MemoError('aiHttpError', String(response.status));
  if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
    let result = '';
    for await (const part of readSse(response.body, signal)) { result += part; onChunk(result); }
    if (!result.trim()) throw new MemoError('aiEmpty');
    return result;
  }
  const result = contentFromResponse(await response.json());
  signal.throwIfAborted(); return result;
}

export { AskPanel, type AskState } from './chat-panel';
