import { sleep } from '../core/timers';
import { Component, MarkdownRenderer, Menu, Notice, setIcon } from 'obsidian';
import type XiaojiPlugin from '../main';
import { buildAssistantChat, DEFAULT_AI_PROMPT, ordinaryQuestion, modelQuestion, buildPlan, chatEndpoint, citedEvidence, parsePlan, retrieve, retrievePlanned, type SearchPlan, type Evidence, type ChatMessage } from '../core/ai';
import { executeMemoQuery, localMemoQuery, queryScope } from '../core/query';
import { reserveDockSpace } from './dock-inset';
import { bindSubmit, shortcutLabel } from './submit';
import { timestamp } from '../core/dates';
import type { Conversation, ChatTurn } from '../core/conversations';
import { MemoError } from '../core/types';
import { complete } from './ask';
import { button, element, empty } from './dom';
import { TextModal } from './modals';

export interface AskState { chatId?: string; question: string; archives: boolean; interrupted: boolean; saved?: boolean; session?: Conversation; }
export class AskPanel extends Component {
  readonly root: HTMLElement;
  readonly saved: boolean;
  private mode: XiaojiPlugin['prefs']['aiMemoMode'];
  private modeSelect: HTMLButtonElement;
  private question: HTMLTextAreaElement;
  private status: HTMLElement;
  private transcript: HTMLElement;
  private title: HTMLElement;
  private submit: HTMLButtonElement;
  private expandedSources = new Set<string>();
  private sourceLoaders = new WeakMap<HTMLDetailsElement, () => Promise<void>>();
  private archives = false;
  private controller: AbortController | null = null;
  private renderComponent = new Component();
  private disposed = false;
  private chat: Conversation | null = null;
  private locked = false;
  private revision = 0;
  private toolbar: HTMLElement;
  constructor(parent: HTMLElement, private plugin: XiaojiPlugin, previous?: AskState, private insertMemo?: (text: string) => void, private appendMenu?: (menu: Menu) => void) {
    super();
    const p = plugin; this.saved = p.prefs.saveConversations; this.mode = p.prefs.aiMemoMode;
    const compatible = previous?.saved === this.saved;
    this.root = element(parent, 'section', 'xj-ask-panel');
    this.toolbar = element(this.root, 'header', 'xj-chat-toolbar');
    this.title = element(this.toolbar, 'span', 'xj-chat-title', p.t('ask'));
    button(this.toolbar, p.t('newChat'), () => this.openChat(), 'square-pen');
    button(this.toolbar, p.t('more'), event => this.chatMenu(event), 'ellipsis');
    this.transcript = element(this.root, 'div', 'xj-chat-transcript');
    this.transcript.setAttribute('role', 'log'); this.transcript.setAttribute('aria-label', p.t('chatHistory'));
    const dock = element(this.root, 'div', 'xj-chat-dock');
    this.question = element(dock, 'textarea'); this.question.maxLength = 12000;
    this.question.placeholder = p.t('question'); this.question.setAttribute('aria-label', p.t('question'));
    this.question.addEventListener('input', () => this.keepInput());
    this.question.addEventListener('blur', () => { void p.flushDrafts?.().catch(error => p.report(error)); });
    bindSubmit(this, this.question, p, () => this.ask());
    const tools = element(dock, 'div', 'xj-chat-compose-tools');
    this.modeSelect = button(tools, p.t(this.mode === 'auto' ? 'memoAuto' : this.mode === 'strict' ? 'memoStrict' : 'memoOff'), event => this.modeMenu(event), undefined, 'xj-ai-mode');
    this.modeSelect.setAttribute('aria-haspopup', 'menu');
    this.submit = button(tools, p.t('send'), () => { if (this.controller) this.controller.abort(); else return this.ask(); }, undefined, 'mod-cta xj-chat-submit');
    this.submit.title = shortcutLabel(p.prefs.submitKey, parent.ownerDocument) + '\n' + p.t('newlineKey') + ' · ' + shortcutLabel(p.prefs.newlineKey, parent.ownerDocument);
    this.register(p.subscribe(() => { this.submit.title = shortcutLabel(p.prefs.submitKey, parent.ownerDocument) + '\n' + p.t('newlineKey') + ' · ' + shortcutLabel(p.prefs.newlineKey, parent.ownerDocument); if (!this.locked) { this.mode = p.prefs.aiMemoMode; this.syncMode(); } }));
    this.status = element(dock, 'span', 'xj-chat-status'); this.status.setAttribute('role', 'status');
    this.archives = previous?.archives ?? false;
    this.register(() => {
      this.disposed = true; this.revision++; this.controller?.abort(); this.renderComponent.unload(); this.toolbar.remove(); this.root.remove();
    });
    this.load(); this.renderComponent.load(); reserveDockSpace(this, this.root);
    this.question.value = previous?.question ?? (this.saved ? p.data.chatInputs?.new : '') ?? '';
    if (!this.saved && compatible && previous?.session) { this.chat = previous.session; this.syncTitle(); void this.draw(); }
    const id = this.saved && (!previous || compatible) ? previous?.chatId ?? p.data.lastChatId : undefined;
    if (id) void this.openChat(id, previous?.question).catch(error => p.report(error));
    else { this.restoreInput(); if (previous?.question !== undefined) { this.question.value = previous.question; this.keepInput(); } }
  }
  mountToolbar(parent: HTMLElement | null): void {
    this.toolbar.classList.toggle('is-inline', Boolean(parent));
    this.title.classList.toggle('xj-chat-page-title', Boolean(parent));
    this.syncTitle();
    if (parent) { this.root.prepend(this.title); parent.append(this.toolbar); }
    else { this.toolbar.prepend(this.title); this.root.prepend(this.toolbar); }
  }
  private syncTitle(): void { this.title.textContent = this.chat?.title ?? this.plugin.t('ask'); this.title.hidden = this.toolbar.classList.contains('is-inline') && !this.chat; }
  private syncMode(): void { this.modeSelect.textContent = this.plugin.t(this.mode === 'auto' ? 'memoAuto' : this.mode === 'strict' ? 'memoStrict' : 'memoOff'); }
  private modeMenu(event: MouseEvent): void {
    if (this.locked) return;
    const menu = new Menu(), p = this.plugin;
    for (const mode of ['auto', 'strict', 'off'] as const) menu.addItem(item => item.setTitle(p.t(mode === 'auto' ? 'memoAuto' : mode === 'strict' ? 'memoStrict' : 'memoOff')).setChecked(mode === this.mode).onClick(() => {
      if (this.locked) return;
      void p.updateSettings({ aiMemoMode: mode }).then(() => { this.mode = mode; this.syncMode(); }).catch(error => p.report(error));
    }));
    if (this.mode !== 'off') { menu.addSeparator(); menu.addItem(item => item.setTitle(p.t('includeArchived')).setChecked(this.archives).onClick(() => { if (!this.locked) this.archives = !this.archives; })); }
    menu.showAtMouseEvent(event);
  }
  private showError(message: string): void { this.status.textContent = message; new Notice(message); }
  focus(): void { this.question.focus(); }
  snapshot(): AskState {
    const session = !this.saved && this.chat ? JSON.parse(JSON.stringify(this.chat)) as Conversation : undefined;
    if (session) for (const turn of session.turns) if (turn.status === 'pending') turn.status = 'interrupted';
    return { saved: this.saved, session, chatId: this.chat?.id, question: this.question.value, archives: this.archives, interrupted: Boolean(this.controller) };
  }
  private keepInput(): void {
    if (!this.saved) return;
    this.plugin.data.chatInputs ??= {};
    this.plugin.data.chatInputs[this.chat?.id ?? 'new'] = this.question.value;
    if (this.plugin.scheduleDraftSave) this.plugin.scheduleDraftSave();
    else void this.plugin.persist().catch(error => this.plugin.report(error));
  }
  private restoreInput(): void { if (!this.saved) return; this.question.value = this.plugin.data.chatInputs?.[this.chat?.id ?? 'new'] ?? ''; }
  private setLocked(value: boolean): void {
    this.locked = value; this.submit.disabled = value && !this.controller;
    this.submit.textContent = this.plugin.t(this.controller ? 'stop' : 'send');
    this.submit.setAttribute('aria-label', this.submit.textContent);
    this.transcript.setAttribute('aria-busy', String(Boolean(this.controller))); this.question.disabled = value; this.modeSelect.disabled = value;
    for (const control of this.toolbar.querySelectorAll<HTMLButtonElement>('button')) control.disabled = value;
    for (const control of this.transcript.querySelectorAll<HTMLButtonElement>('[data-chat-mutate]')) control.disabled = value;
  }
  private async openChat(id?: string, question?: string): Promise<void> {
    if (this.locked || this.disposed) return;
    this.keepInput(); this.setLocked(true);
    try {
      const chat = id ? await this.plugin.chats.load(id) : null;
      if (this.disposed) return;
      this.chat = chat;
      if (this.saved) { this.plugin.data.lastChatId = id; await this.plugin.persist(); }
      else this.question.value = '';
      this.restoreInput(); if (question !== undefined) this.question.value = question;
      this.syncTitle();
      await this.draw();
      if (!this.disposed) { this.status.textContent = ''; this.focus(); }
    } catch {
      if (!this.disposed) this.showError(this.plugin.t('chatInvalid'));
    } finally { if (!this.disposed) this.setLocked(false); }
  }
  private async historyMenu(event: MouseEvent): Promise<void> {
    if (this.locked) return;
    const result = await this.plugin.chats.list();
    const menu = new Menu();
    if (!result.chats.length) menu.addItem(item => item.setTitle(this.plugin.t('chatNone')).setDisabled(true));
    for (const chat of result.chats) menu.addItem(item => item.setTitle(chat.title).setChecked(chat.id === this.chat?.id)
      .onClick(() => { void this.openChat(chat.id); }));
    if (result.damaged.length) new Notice(this.plugin.t('chatInvalid'));
    menu.showAtMouseEvent(event);
  }
  private chatMenu(event: MouseEvent): void {
    const chat = this.chat; if (this.locked) return;
    const p = this.plugin, menu = new Menu();
    if (this.saved) menu.addItem(item => item.setTitle(p.t('chatHistory')).setIcon('history').onClick(() => { void this.historyMenu(event).catch(error => p.report(error)); }));
    if (chat) {
      menu.addItem(item => item.setTitle(p.t('renameChat')).setIcon('pencil').onClick(() => {
        new TextModal(p, p.t('renameChat'), [{ label: p.t('title'), value: chat.title }], async values => {
          const old = chat.title; chat.title = values[0]?.slice(0, 100) || old;
          try { await this.saveChat(chat); this.syncTitle(); }
          catch (error) { chat.title = old; throw error; }
        }).open();
      }));
      menu.addItem(item => item.setTitle(p.t('deleteChat')).setIcon('trash-2').onClick(() => {
        void (async () => {
          this.setLocked(true);
          try {
            if (this.saved) { await p.chats.delete(chat); if (p.data.chatInputs) delete p.data.chatInputs[chat.id]; p.data.lastChatId = undefined; await p.persist(); }
            this.chat = null; this.question.value = '';
            this.restoreInput(); this.syncTitle(); await this.draw(); p.notify();
            new Notice(p.t('purged'));
          } catch (error) { p.report(error); }
          finally { if (!this.disposed) this.setLocked(false); }
        })();
      }));
    }
    if (this.appendMenu) { menu.addSeparator(); this.appendMenu(menu); }
    menu.showAtMouseEvent(event);
  }
  private async draw(): Promise<void> {
    const revision = ++this.revision;
    const top = this.transcript.scrollTop;
    const follow = this.transcript.scrollHeight - top - this.transcript.clientHeight < 60;
    for (const group of this.transcript.querySelectorAll<HTMLDetailsElement>('details.xj-chat-sources')) {
      const id = group.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
      if (id) { if (group.open) this.expandedSources.add(id); else this.expandedSources.delete(id); }
    }
    this.renderComponent.unload(); this.renderComponent = new Component(); this.renderComponent.load();
    empty(this.transcript); this.sourceLoaders = new WeakMap();
    if (!this.chat?.turns.length) { element(this.transcript, 'p', 'xj-chat-empty', this.plugin.t('question')); return; }
    for (const turn of this.chat.turns) {
      if (this.disposed || revision !== this.revision) return;
      const row = element(this.transcript, 'article', 'xj-chat-turn'); row.dataset.turnId = turn.id;
      const question = element(row, 'div', 'xj-chat-question-wrap');
      element(question, 'div', 'xj-chat-question', turn.question);
      const questionActions = element(question, 'div', 'xj-chat-message-actions xj-chat-question-actions');
      this.copyAction(questionActions, turn.question);
      const edit = button(questionActions, this.plugin.t('editQuestion'), () => this.reuseQuestion(turn.question), 'pencil');
      edit.dataset.chatMutate = ''; edit.disabled = this.locked;
      const answer = element(row, 'div', 'xj-ai-answer xj-markdown markdown-rendered');
      if (turn.answer) {
        const safe = turn.answer.replace(/</g, '&lt;').replace(/!\[/g, '\\![');
        await MarkdownRenderer.render(this.plugin.app, safe, answer, '', this.renderComponent);
        this.citations(answer, turn.sources);
        this.codeActions(answer);
      }
      if (this.disposed || revision !== this.revision) return;
      if (turn.query && turn.query.action !== 'answer') {
        const scope = element(row, 'small', 'xj-hint xj-query-scope', turn.query.scope); scope.title = this.plugin.t('localQueryHint');
      }
      this.plugin.renderReferences(answer);
      const actions = element(row, 'div', 'xj-chat-turn-actions xj-chat-message-actions');
      if (turn.answer) this.copyAction(actions, turn.answer);
      const more = button(actions, this.plugin.t('more'), event => this.messageMenu(event, turn), 'ellipsis');
      more.dataset.chatMutate = ''; more.disabled = this.locked;
      if (turn.status === 'failed' || turn.status === 'interrupted' || turn.status === 'pending' && !this.controller) {
        const retry = button(actions, this.plugin.t('retry'), () => this.reuseQuestion(turn.question), 'rotate-ccw');
        retry.dataset.chatMutate = ''; retry.disabled = this.locked;
      }
      if (!turn.sources.length) continue;
      const sources = element(row, 'details', 'xj-chat-sources');
      sources.open = this.expandedSources.has(turn.id);
      sources.addEventListener('toggle', () => { if (!sources.isConnected) return; if (sources.open) this.expandedSources.add(turn.id); else this.expandedSources.delete(turn.id); });
      element(sources, 'summary', 'xj-muted', this.plugin.t('relatedMemos', { count: turn.sources.length }));
      const bodies: { body: HTMLElement; source: Evidence }[] = [];
      for (const source of turn.sources) {
        const card = element(sources, 'section', 'xj-chat-source');
        card.id = 'xj-source-' + turn.id + '-' + source.number;
        const heading = element(card, 'div', 'xj-card-heading');
        element(heading, 'small', 'xj-muted', '[' + source.number + '] ' + this.plugin.date(source.memo));
        const reference = element(heading, 'a', 'xj-reference', '@' + source.memo.id);
        reference.href = '#'; reference.dataset.xjId = source.memo.id; this.plugin.bindReferences(heading);
        const body = element(card, 'div', 'xj-markdown markdown-rendered');
        bodies.push({ body, source });
      }
      let loading: Promise<void> | null = null;
      const load = (): Promise<void> => loading ??= (async () => {
        for (const { body, source } of bodies) {
          if (this.disposed || revision !== this.revision || !sources.isConnected) return;
          await MarkdownRenderer.render(this.plugin.app, source.memo.body, body, source.memo.path, this.renderComponent);
          this.plugin.renderReferences(body);
          for (const checkbox of body.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) checkbox.disabled = true;
        }
      })();
      this.sourceLoaders.set(sources, load);
      sources.addEventListener('toggle', () => { if (sources.open) void load().catch(error => this.plugin.report(error)); });
      if (sources.open) await load();
    }
    this.transcript.scrollTop = follow ? this.transcript.scrollHeight : top;
  }
  private copyAction(parent: HTMLElement, text: string): void {
    let timer: number | undefined;
    const copy = button(parent, this.plugin.t('messageCopy'), async () => {
      try {
        await this.plugin.clipboard(text, parent.ownerDocument, false);
        if (!copy.isConnected) return;
        window.clearTimeout(timer); setIcon(copy, 'check'); copy.setAttribute('aria-label', this.plugin.t('copied')); copy.title = this.plugin.t('copied');
        timer = window.setTimeout(() => { if (copy.isConnected) { setIcon(copy, 'copy'); copy.setAttribute('aria-label', this.plugin.t('messageCopy')); copy.title = this.plugin.t('messageCopy'); } }, 1400);
      } catch (error) { this.plugin.report(error); }
    }, 'copy', 'xj-chat-copy');
    this.renderComponent.register(() => window.clearTimeout(timer));
  }
  private codeActions(answer: HTMLElement): void {
    for (const pre of answer.querySelectorAll<HTMLElement>('pre')) {
      const code = pre.querySelector('code'); if (!code) continue;
      for (const native of pre.querySelectorAll('.copy-code-button')) native.remove();
      const actions = element(pre, 'div', 'xj-chat-code-actions'); this.copyAction(actions, code.textContent ?? '');
    }
  }
  private reuseQuestion(text: string): void {
    if (this.locked) return;
    const current = this.question.value;
    this.question.value = current.trim() && current.trim() !== text.trim() ? current.replace(/\s+$/, '') + '\n\n' + text : text;
    this.keepInput(); this.focus(); this.question.setSelectionRange(this.question.value.length, this.question.value.length);
  }
  private messageMenu(event: MouseEvent, turn: ChatTurn): void {
    if (this.locked) return;
    const menu = new Menu(), p = this.plugin;
    menu.addItem(item => item.setTitle(p.t('askAgain')).setIcon('rotate-ccw').onClick(() => this.reuseQuestion(turn.question)));
    if (turn.answer && this.insertMemo) menu.addItem(item => item.setTitle(p.t('insertIntoMemo')).setIcon('notebook-pen').onClick(() => {
      if (this.locked) return;
      try { this.insertMemo?.(turn.answer + (turn.sources.length ? '\n\n' + turn.sources.map(source => '[' + source.number + '] @' + source.memo.id).join('\n') : '')); }
      catch (error) { p.report(error); }
    }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(p.t('deleteTurn')).setIcon('trash-2').onClick(() => { void this.removeTurn(turn).catch(error => p.report(error)); }));
    menu.showAtMouseEvent(event);
  }
  private citations(root: HTMLElement, sources: Evidence[]): void {
    const walker = root.ownerDocument.createTreeWalker(root, 4), nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) if (!node.parentElement?.closest('a,code,pre')) nodes.push(node as Text);
    for (const text of nodes) {
      const fragment = text.ownerDocument.win.createFragment(); let offset = 0, changed = false;
      for (const match of text.data.matchAll(/\[(\d+)\]/g)) {
        const source = sources.find(source => source.number === Number(match[1])); if (!source) continue;
        fragment.append(text.data.slice(offset, match.index));
        const link = fragment.createEl('a'); link.href = '#'; link.className = 'xj-evidence-link'; link.textContent = match[0];
        link.addEventListener('click', event => {
          void (async () => {
            event.preventDefault();
            const turn = link.closest('.xj-chat-turn');
            const card = [...(turn?.querySelectorAll<HTMLElement>('.xj-chat-source') ?? [])].find(card => card.id.endsWith('-' + source.number));
            const group = card?.closest<HTMLDetailsElement>('details.xj-chat-sources');
            if (group) { group.open = true; await this.sourceLoaders.get(group)?.().catch(error => this.plugin.report(error)); const id = turn?.getAttribute('data-turn-id'); if (id) this.expandedSources.add(id); }
            card?.scrollIntoView({ block: 'nearest' });
            if (card) { card.classList.remove('is-highlighted'); void card.offsetWidth; card.classList.add('is-highlighted'); }
          })().catch(error => this.plugin.report(error));
        });
        fragment.append(link); offset = match.index + match[0].length; changed = true;
      }
      if (changed) { fragment.append(text.data.slice(offset)); text.replaceWith(fragment); }
    }
  }
  private async saveChat(chat: Conversation): Promise<void> {
    if (!this.saved) return;
    try { await this.plugin.chats.save(chat); } catch (error) { if (error instanceof MemoError && error.code === 'chatConflict') throw error; throw new MemoError('chatSaveFailed'); }
  }
  private async removeTurn(turn: ChatTurn): Promise<void> {
    const chat = this.chat; if (!chat || this.locked) return;
    this.setLocked(true); const previous = chat.turns; chat.turns = previous.filter(item => item !== turn);
    try { await this.saveChat(chat); await this.draw(); }
    catch (error) { chat.turns = previous; this.plugin.report(error); }
    finally { if (!this.disposed) this.setLocked(false); }
  }
  private async ask(): Promise<void> {
    if (this.locked || this.disposed || !this.question.value.trim()) return;
    const p = this.plugin, question = this.question.value.trim();
    const mode = this.mode;
    const local = mode === 'off' ? null : localMemoQuery(question);
    const identity = modelQuestion(question) && p.prefs.aiModel.trim() ? (p.locale === 'zh' ? '当前配置的模型是 **' + p.prefs.aiModel.replace(/[\r\n*`]/g, '') + '**。这是服务请求中的模型标识，实际模型映射由服务提供方决定。' : 'The configured model is **' + p.prefs.aiModel.replace(/[\r\n*`]/g, '') + '**. The service provider controls the actual model mapping.') : '';
    const direct = mode === 'off' || ordinaryQuestion(question) || Boolean(identity);
    let endpoint = '', key = '';
    try { if (!local && !identity) { endpoint = chatEndpoint(p.prefs.aiBaseUrl); key = p.apiKey(); if (!key || !p.prefs.aiModel) throw new MemoError('aiNotConfigured'); } }
    catch { this.showError(p.t('aiNotConfigured')); return; }
    const controller = new AbortController(); this.controller = controller;
    this.setLocked(true);
    let reading = false;
    let turn: ChatTurn | undefined, timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    const signal = controller.signal;
    const bridge = (): void => undefined;
    try {
      let records: XiaojiPlugin['repo']['records'] = [];
      if (local) { reading = true; records = await p.repo.scan(); reading = false; }
      signal.throwIfAborted();
      if (!this.chat) {
        this.chat = this.saved ? await p.chats.create(question) : { id: timestamp(), title: question.slice(0, 100), turns: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (this.saved) { p.data.lastChatId = this.chat.id; await p.persist(); } this.syncTitle();
      }
      const chat = this.chat;
      const history = chat.turns.filter(turn => turn.status === 'complete').slice(-3).map(turn => 'Q: ' + turn.question + '\nA: ' + turn.answer).join('\n\n').slice(-6000);
      const messages: ChatMessage[] = chat.turns.filter(turn => turn.status === 'complete').slice(-6).flatMap(turn => [{ role: 'user' as const, content: turn.question.slice(0, 4000) }, { role: 'assistant' as const, content: turn.answer.slice(0, 8000) }]);
      let id = timestamp(); while (chat.turns.some(turn => turn.id === id)) { await sleep(2); id = timestamp(); }
      turn = { id, question, answer: '', sources: [], status: 'pending', createdAt: new Date().toISOString() };
      chat.turns.push(turn); await this.saveChat(chat);
      this.question.value = ''; this.keepInput();
      if (this.saved && p.data.chatInputs) delete p.data.chatInputs.new;
      await this.draw(); this.status.textContent = p.t(direct ? 'thinking' : local ? 'aiSearching' : 'aiPlanning');
      let plan: SearchPlan = local ? { queries: [], query: local } : { queries: [] };
      if (!local && !direct) {
        const planController = new AbortController(), abortPlan = (): void => planController.abort();
        signal.addEventListener('abort', abortPlan, { once: true });
        const planTimer = window.setTimeout(abortPlan, 20000);
        try { plan = parsePlan(await complete(endpoint, key, buildPlan(question, p.prefs.aiModel, history), planController.signal, () => undefined, bridge)); }
        catch { signal.throwIfAborted(); }
        finally { window.clearTimeout(planTimer); signal.removeEventListener('abort', abortPlan); }
      }
      signal.throwIfAborted();
      const useMemos = (mode !== 'off' && !direct && (mode === 'strict' || plan.route !== 'chat')) || Boolean(local);
      let retrievalFailed = false;
      if (useMemos && !local) {
        this.status.textContent = p.t('aiSearching');
        try { records = await p.repo.scan(); } catch { retrievalFailed = true; if (mode === 'strict' || plan.query?.action === 'count' || plan.query?.action === 'list') { reading = true; throw new MemoError('readFailed'); } records = []; }
      }
      signal.throwIfAborted();
      const q = useMemos ? plan.query : undefined;
      const candidates = q ? executeMemoQuery(q, records, this.archives) : records.filter(memo => this.archives || !memo.archived);
      const scope = q ? queryScope(q, p.locale === 'zh', this.archives) : '';
      if (q?.action === 'count' || q?.action === 'list') {
        const shown = q.action === 'list' ? candidates.slice(0, p.prefs.aiMaxMemos) : [];
        turn.query = { action: q.action, total: candidates.length, shown: shown.length, scope };
        turn.answer = p.locale === 'zh' ? '共 **' + candidates.length + '** 条小记。' : '**' + candidates.length + '** memos.';
        if (q.action === 'list') {
          turn.sources = shown.map((memo, index) => ({ number: index + 1, memo: structuredClone(memo), content: memo.body }));
          turn.answer += p.locale === 'zh' ? '\n\n下方展示最近 ' + shown.length + ' 条的完整原文。' : '\n\nShowing the full text of the most recent ' + shown.length + ' memos below.';
        }
        turn.status = 'complete';
      } else {
        let evidence = !useMemos || retrievalFailed ? [] : plan.queries.length ? retrievePlanned(question + ' ' + history.slice(-1200), plan, candidates, p.prefs) : retrieve(question, candidates, p.prefs);
        if (!retrievalFailed && q && !evidence.length && (q.from || q.until || q.tags?.length || q.tasks || q.pinned !== undefined || q.text)) evidence = retrieve(question, candidates, p.prefs, true);
        if (q) turn.query = { action: q.action, total: candidates.length, shown: evidence.length, scope };
        if (identity) { turn.answer = identity; turn.status = 'complete'; }
        else if (!evidence.length && mode === 'strict' && !direct) { turn.answer = p.t('noEvidence'); turn.status = 'complete'; }
        else {
          this.status.textContent = p.t('thinking');
          const output = this.transcript.querySelectorAll<HTMLElement>('.xj-ai-answer');
          const live = output.item(output.length - 1);
          const coverage = q ? JSON.stringify({ totalMatching: candidates.length, supplied: evidence.length, scope }) : '';
          turn.answer = await complete(endpoint, key, buildAssistantChat(question, evidence, p.prefs.aiModel, mode, p.prefs.aiSystemPrompt || (DEFAULT_AI_PROMPT + (p.prefs.aiInstructions ? '\n' + p.prefs.aiInstructions : '')), messages, coverage, retrievalFailed), signal, text => {
            turn!.answer = text; if (!this.disposed && live) {
              const follow = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 60;
              live.textContent = text; if (follow) this.transcript.scrollTop = this.transcript.scrollHeight;
            }
          }, bridge);
          signal.throwIfAborted();
          turn.sources = citedEvidence(turn.answer, evidence).map(source => JSON.parse(JSON.stringify(source)) as Evidence);
          turn.status = 'complete';
        }
      }
      await this.saveChat(chat);
      if (!this.disposed) { await this.draw(); this.status.textContent = ''; }
    } catch (error) {
      if (turn && this.chat) {
        turn.status = signal.aborted ? 'interrupted' : 'failed';
        try { await this.saveChat(this.chat); } catch { if (!this.disposed) this.showError(p.t('chatSaveFailed')); }
      }
      if (!this.disposed) {
        await this.draw();
        const message = signal.aborted ? (timedOut ? p.t('aiTimeout') : '') :
          reading ? p.t('queryFailed') : error instanceof MemoError && error.code === 'chatConflict' ? p.t('chatConflict') : error instanceof MemoError && error.code === 'chatSaveFailed' ? p.t('chatSaveFailed') : p.t('aiRequestFailed');
        if (message) this.showError(message); else this.status.textContent = '';
      }
    } finally {
      window.clearTimeout(timer); this.controller = null;
      if (!this.disposed) { this.setLocked(false);
        for (const control of this.transcript.querySelectorAll<HTMLButtonElement>('[data-chat-mutate]')) control.disabled = false; }
    }
  }
}
