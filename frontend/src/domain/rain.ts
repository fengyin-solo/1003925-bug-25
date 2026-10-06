import {
  beginDraft,
  commitDraft,
  listRows,
  nextId,
  withDraft,
  type Draft,
} from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 雨量领域服务：阈值判定、通知生成、异常回写共用同一套键与同一段事务，
// 根治“列表/详情/预警三处各写各的、重复通知与旧触发标记残留”的问题。

export const RAIN_KEY = 'rain_gauge'
export const ALARM_KEY = 'alarm'
export const THRESHOLD_KEY = 'threshold'

export const SOURCE_MODULE = 'rain_gauge'
const RECEIVER = '值班室、属地乡镇'
const PUBLISHER = '系统自动'

export type RainLevel = '注意级' | '警示级' | '警戒级'
export type LevelThresholds = { 注意级: number; 警示级: number; 警戒级: number }

export type RainSummary = {
  reviewed: number
  triggered: number
  created: number
  reused: number
  withdrawn: number
  deduped: number
  unchanged: number
  items: { code: string; station: string; level: RainLevel | null; rain: number }[]
}

type MarkSummary = {
  marked: number
  withdrawn: number
  deduped: number
  unchanged: number
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function stationOf(row: EntryRow): string {
  return String(row['站点编号'] ?? '')
}

function codeOf(row: EntryRow): string {
  return String(row['记录编号'] ?? '')
}

// 取某条雨量记录用于判定的雨强：优先小时最大雨强，缺失时回落到时段雨量。
export function rainIntensity(row: EntryRow): number {
  const hourly = toNumber(row['小时最大雨强'])
  const period = toNumber(row['时段雨量'])
  return Math.max(hourly, period)
}

// 生效中的雨量阈值：站点专属配置优先，其次全局（隐患点编号 ALL）配置。
export function resolveThresholds(
  thresholdRows: EntryRow[],
  station: string,
): LevelThresholds | null {
  const effective = thresholdRows.filter(
    (row) =>
      String(row.status) === '已生效' && String(row['监测类型'] ?? '').trim() === '雨量',
  )
  const exact = effective.find((row) => String(row['隐患点编号'] ?? '') === station)
  const global = effective.find((row) => String(row['隐患点编号'] ?? '') === 'ALL')
  // 只有显式的全局（ALL）配置可兜底；其它站点的专属阈值不能错配。
  const picked = exact ?? global
  if (!picked) {
    return null
  }
  return {
    注意级: toNumber(picked['注意级阈值']),
    警示级: toNumber(picked['警示级阈值']),
    警戒级: toNumber(picked['警戒级阈值']),
  }
}

// 阈值判定：就高不就低，从警戒级往下比，返回命中的最高等级。
export function evaluateLevel(
  row: EntryRow,
  thresholdRows: EntryRow[],
): { rain: number; level: RainLevel | null; thresholds: LevelThresholds | null } {
  const rain = rainIntensity(row)
  const thresholds = resolveThresholds(thresholdRows, stationOf(row))
  if (!thresholds) {
    return { rain, level: null, thresholds: null }
  }
  let level: RainLevel | null = null
  if (rain >= thresholds.警戒级) {
    level = '警戒级'
  } else if (rain >= thresholds.警示级) {
    level = '警示级'
  } else if (rain >= thresholds.注意级) {
    level = '注意级'
  }
  return { rain, level, thresholds }
}

function linkedActiveAlarms(alarmRows: EntryRow[], code: string): EntryRow[] {
  return alarmRows.filter(
    (row) =>
      String(row['来源模块'] ?? '') === SOURCE_MODULE &&
      String(row['来源记录编号'] ?? '') === code &&
      !['误报', '已解除'].includes(String(row.status)),
  )
}

// 幂等去重：同一条雨量记录只保留一次有效触发，编号最小（最早）的留下，
// 其余重复通知统一回写为误报，保证“反复越线只保留一次触发”。
function reconcileAlarms(
  draft: Draft,
  code: string,
  reason: string,
): { kept: EntryRow | null; deduped: number } {
  const rows = draft[ALARM_KEY] ?? []
  const active = linkedActiveAlarms(rows, code)
  if (active.length <= 1) {
    return { kept: active[0] ?? null, deduped: 0 }
  }
  active.sort((a, b) => Number(a.id) - Number(b.id))
  const [kept, ...duplicates] = active
  const duplicateIds = new Set(duplicates.map((row) => row.id))
  draft[ALARM_KEY] = rows.map((row) =>
    duplicateIds.has(row.id)
      ? {
          ...row,
          status: '误报',
          pending: false,
          abnormal: true,
          通知状态: '误报',
          触发条件: `${String(row['触发条件'] ?? '')}（${reason}）`,
        }
      : row,
  )
  return { kept, deduped: duplicates.length }
}

function withdrawPendingAlarms(
  draft: Draft,
  code: string,
  reason: string,
): { withdrawn: number; deduped: number } {
  const { deduped } = reconcileAlarms(draft, code, reason)
  const rows = draft[ALARM_KEY] ?? []
  let withdrawn = 0
  draft[ALARM_KEY] = rows.map((row) => {
    const isLinked =
      String(row['来源模块'] ?? '') === SOURCE_MODULE &&
      String(row['来源记录编号'] ?? '') === code
    // 已发布/已响应的通知不能被静默撤回，只清理仍在发布链路（待发布）上的触发。
    if (!isLinked || String(row.status) !== '待发布') {
      return row
    }
    withdrawn += 1
    return {
      ...row,
      status: '误报',
      pending: false,
      abnormal: true,
      通知状态: '误报',
      触发条件: `${String(row['触发条件'] ?? '')}（${reason}）`,
    }
  })
  return { withdrawn, deduped }
}

function buildAlarm(row: EntryRow, level: RainLevel, rain: number, threshold: number): EntryRow {
  const alarmRows = listRows(ALARM_KEY)
  const id = nextId(alarmRows)
  const now = new Date()
  const pad = (v: number) => String(v).padStart(2, '0')
  const publishTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
  return {
    id,
    status: '待发布',
    pending: true,
    abnormal: false,
    通知编号: `ALAR-${String(id).padStart(4, '0')}`,
    隐患点编号: stationOf(row),
    预警等级: level,
    触发条件: `小时最大雨强 ${rain.toFixed(1)}mm 超过${level}阈值 ${threshold}mm`,
    发布时间: publishTime,
    接收单位: RECEIVER,
    发布人: PUBLISHER,
    通知状态: '待发布',
    来源模块: SOURCE_MODULE,
    来源记录编号: codeOf(row),
  }
}

// 复核（单条或批量）：在同一个事务里更新雨量结论、通知清单，异常标记一并复核。
// 任一条记录找不到、缺阈值或写入失败，整批回滚，不产生半条结论、半张通知。
export function reviewRainRecords(ids: number[]): RainSummary {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    throw new Error('请先选择需要复核的雨量记录')
  }
  const draft = beginDraft()
  const rainRows = draft[RAIN_KEY] ?? []
  const thresholdRows = draft[THRESHOLD_KEY] ?? []
  const summary: RainSummary = {
    reviewed: 0,
    triggered: 0,
    created: 0,
    reused: 0,
    withdrawn: 0,
    deduped: 0,
    unchanged: 0,
    items: [],
  }

  const indexById = new Map(rainRows.map((row, index) => [Number(row.id), index]))
  for (const id of uniqueIds) {
    const index = indexById.get(id)
    if (index === undefined) {
      throw new Error(`没有找到编号为 ${id} 的雨量记录，整批复核已撤销`)
    }
    const current = rainRows[index]
    if (String(current.status) === '异常值') {
      throw new Error(`${codeOf(current)} 已人工判定为异常值，请先核实记录，整批复核已撤销`)
    }

    const { rain, level, thresholds } = evaluateLevel(current, thresholdRows)
    if (!thresholds) {
      throw new Error(`站点 ${stationOf(current)} 没有生效中的雨量阈值，整批复核已撤销`)
    }

    const code = codeOf(current)
    const nextStatus = level ? '达预警值' : '已审核'
    const wasReviewed = ['已审核', '达预警值'].includes(String(current.status))
    const conclusionChanged = !wasReviewed || String(current.status) !== nextStatus

    // 无论结论是否变化都重写结论并做一次完整对账；
    // 结论未变时计入 unchanged，但绝不再生成通知（下面 kept 已存在即复用）。
    const updated: EntryRow = {
      ...current,
      status: nextStatus,
      pending: false,
      abnormal: false,
      是否触发预警: level ? '是' : '否',
      记录状态: nextStatus,
    }
    draft[RAIN_KEY] = [...draft[RAIN_KEY]]
    draft[RAIN_KEY][index] = updated
    if (conclusionChanged) {
      summary.reviewed += 1
    } else {
      summary.unchanged += 1
    }
    summary.items.push({ code, station: stationOf(current), level, rain })

    // 先把历史重复触发对账收敛到一条，再决定落账还是撤回。
    const reconcile = reconcileAlarms(draft, code, '系统去重：同一记录重复触发')
    summary.deduped += reconcile.deduped

    if (level) {
      summary.triggered += 1
      if (reconcile.kept) {
        summary.reused += 1
      } else {
        const threshold = thresholds[level]
        draft[ALARM_KEY] = [...(draft[ALARM_KEY] ?? []), buildAlarm(updated, level, rain, threshold)]
        summary.created += 1
      }
    } else {
      // 复核结论为未越线：撤掉仍在发布链路上的旧触发，同步清掉“是否触发预警”。
      const result = withdrawPendingAlarms(draft, code, '复核结论为正常，触发撤回')
      summary.withdrawn += result.withdrawn
      summary.deduped += result.deduped
    }
  }

  commitDraft(draft)
  return summary
}

// 人工判异常：一个事务里回写异常结论、清掉旧触发标记、撤回待发布通知。
export function markRainRecordsAbnormal(ids: number[]): MarkSummary {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    throw new Error('请先选择需要标记异常的雨量记录')
  }
  let summary: MarkSummary = { marked: 0, withdrawn: 0, deduped: 0, unchanged: 0 }
  withDraft((draft) => {
    const rainRows = draft[RAIN_KEY] ?? []
    const indexById = new Map(rainRows.map((row, index) => [Number(row.id), index]))
    for (const id of uniqueIds) {
      const index = indexById.get(id)
      if (index === undefined) {
        throw new Error(`没有找到编号为 ${id} 的雨量记录，异常标记已撤销`)
      }
      const current = rainRows[index]
      const code = codeOf(current)
      if (String(current.status) === '异常值') {
        // 幂等：重复判异常不再重复回写、不重复撤通知。
        const { deduped } = reconcileAlarms(draft, code, '系统去重：同一记录重复触发')
        summary.deduped += deduped
        summary.unchanged += 1
        continue
      }
      draft[RAIN_KEY] = [...draft[RAIN_KEY]]
      draft[RAIN_KEY][index] = {
        ...current,
        status: '异常值',
        pending: false,
        abnormal: true,
        是否触发预警: '否',
        记录状态: '异常值',
      }
      summary.marked += 1
      const result = withdrawPendingAlarms(draft, code, '人工判定异常，触发撤回')
      summary.withdrawn += result.withdrawn
      summary.deduped += result.deduped
    }
  })
  return summary
}

export function notificationsOfRain(code: string): EntryRow[] {
  return listRows(ALARM_KEY).filter(
    (row) =>
      String(row['来源模块'] ?? '') === SOURCE_MODULE &&
      String(row['来源记录编号'] ?? '') === code,
  )
}

export function effectiveRainThresholds(): { station: string; thresholds: LevelThresholds }[] {
  const rows = listRows(THRESHOLD_KEY).filter(
    (row) =>
      String(row.status) === '已生效' && String(row['监测类型'] ?? '').trim() === '雨量',
  )
  return rows.map((row) => ({
    station: String(row['隐患点编号'] ?? ''),
    thresholds: {
      注意级: toNumber(row['注意级阈值']),
      警示级: toNumber(row['警示级阈值']),
      警戒级: toNumber(row['警戒级阈值']),
    },
  }))
}
