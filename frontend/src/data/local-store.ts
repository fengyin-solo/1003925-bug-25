import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：雨量阈值/通知联动改造后，雨量与通知字段结构变更，旧缓存不再兼容。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 事务支持：先拿到一份整库草稿（深拷贝），所有模块在草稿上改，
// 最后一次性 commit。中途抛错则草稿丢弃、已提交缓存不动，实现“失败全部撤销”。
export type Draft = Record<string, EntryRow[]>

export function beginDraft(): Draft {
  return clone(allRows())
}

export function commitDraft(draft: Draft): void {
  // 再克隆一份落库，避免调用方在提交后继续持引用改动。
  cache = clone(draft)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

// 在一个事务里同时改多个模块：回调返回 true/commit 时整体生效，抛错则整体回滚。
export function withDraft(mutate: (draft: Draft) => void): void {
  const draft = beginDraft()
  mutate(draft)
  commitDraft(draft)
}

export function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
