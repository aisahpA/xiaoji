import { chatEndpoint, type ChatRequest } from '../core/ai';
import type { CodexClient } from '../core/codex';
import { MemoError, type Settings } from '../core/types';
import { complete } from './ask';

export interface AIBackend {
  model: string;
  planTimeout: number;
  timeout: number;
  complete(request: ChatRequest, signal: AbortSignal, onChunk: (text: string) => void): Promise<string>;
}
export function createAIBackend(settings: Settings, key: string, codex?: CodexClient): AIBackend {
  if (settings.aiProvider === 'codex') {
    if (!codex) throw new MemoError('codexDesktopOnly');
    return { model: settings.codexModel, planTimeout: 45000, timeout: 240000,
      complete: (request, signal, onChunk) => codex.complete(request, signal, onChunk) };
  }
  const endpoint = chatEndpoint(settings.aiBaseUrl);
  if (!key || !settings.aiModel.trim()) throw new MemoError('aiNotConfigured');
  return { model: settings.aiModel, planTimeout: 20000, timeout: 120000,
    complete: (request, signal, onChunk) => complete(endpoint, key, request, signal, onChunk, () => undefined) };
}
