import { moment as hostMoment } from 'obsidian';
import type momentFactory from 'moment';
// The host exports the callable factory; its declaration uses a namespace import.
const moment = hostMoment as unknown as typeof momentFactory;
import { MemoError, type Grouping, type Settings } from './types';
import { normalizeFolder, safeFileName } from './settings';

export const ID_FORMAT = 'YYYYMMDDHHmmssSSS';

export function dateFromId(id: string): number | null {
  if (!/^\d{17}$/.test(id)) return null;
  const parsed = moment(id, ID_FORMAT, true);
  return parsed.isValid() ? parsed.valueOf() : null;
}

export function timestamp(date: Date = new Date()): string {
  return moment(date).format(ID_FORMAT);
}

export function groupKey(time: number, grouping: Grouping): string {
  if (grouping === 'none') return '';
  const date = moment(time);
  return date.format(grouping === 'day' ? 'YYYY-MM-DD' : grouping === 'week' ? 'GGGG-[W]WW' : 'YYYY-MM');
}

export function fileForDate(date: Date | number, settings: Settings): string {
  const name = safeFileName(moment(date).format(settings.fileFormats[settings.period]));
  return normalizeFolder(settings.folder) + '/' + name + '.md';
}

export function headingForDate(date: Date | number, settings: Settings): string {
  if (settings.grouping === 'none') return '';
  const title = moment(date).format(settings.headingFormats[settings.grouping]);
  if (!title.trim() || /[\r\n]/.test(title)) throw new MemoError('invalidHeading');
  return '#'.repeat(settings.headingLevel) + ' ' + title;
}

export function validateStorageSettings(settings: Settings): void {
  normalizeFolder(settings.folder);
  const chat = normalizeFolder(settings.chatFolder), memo = normalizeFolder(settings.folder);
  if (chat === memo || memo.startsWith(chat + '/')) throw new MemoError('invalidFolder');
  const names = new Set<string>();
  const count = settings.period === 'month' ? 24 : settings.period === 'quarter' ? 8 : 3;
  const step = settings.period === 'month' ? 1 : settings.period === 'quarter' ? 3 : 12;
  for (let i = 0; i < count; i++) {
    const date = moment('2026-01-15', 'YYYY-MM-DD', true).add(i * step, 'months');
    const name = fileForDate(date.valueOf(), settings);
    if (names.has(name.toLocaleLowerCase())) throw new MemoError('templateCollision');
    names.add(name.toLocaleLowerCase());
    headingForDate(date.valueOf(), settings);
  }
}

export function withinWeek(time: number, now: number = Date.now()): boolean {
  const start = moment(now).startOf('isoWeek');
  return time >= start.valueOf() && time < start.clone().add(1, 'week').valueOf();
}

export function displayDate(time: number, format: string, language: 'zh' | 'en'): string {
  return moment(time).locale(language === 'zh' ? 'zh-cn' : 'en').format(format);
}
