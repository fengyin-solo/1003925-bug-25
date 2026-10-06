import { listRows, runInTransaction, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 雨量链路要同时动三本账：雨量记录（结论）、预警通知（清单）、阈值配置（判定依据）。
// 旧实现里三条线各写各的、没有事务也没有幂等约束，才会出现重复通知和撤不掉的触发标记。
const RAIN_KEY = 'rain_gauge'
const ALARM_KEY = 'alarm'
const THRESHOLD_KEY = 'threshold'

const FIELD_TRIGGERED = '是否触发预警'
const FIELD_CONCLUSION = '雨量结论'
// 通知上回写来源记录编号，查重和判异常时的关联撤销都靠它。
const FIELD_SOURCE = '来源记录编号'

const RAIN_STATUS = {
  collected: '已采集',
  reviewed: '已审核',
  triggered: '达预警值',
  abnormal: '异常值',
} as const

const ALARM_STATUS_FALSE = '误报'

// 判定用的雨量指标，越线原因里要指名道姓写出来。
const METRICS = ['时段雨量', '日累计雨量', '小时最大雨强'] as const

// 等级从高到低匹配，命中即停，结论取最高等级。
const LEVELS = [
  { level: '警戒级', field: '警戒级阈值' },
  { level: '警示级', field: '警示级阈值' },
  { level: '注意级', field: '注意级阈值' },
] as const

export type RainJudgment = {
  crossed: boolean
  level: string
  reasons: string[]
  thresholdReady: boolean
}

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function findRainIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

/** 通知清单里和这条雨量记录关联的全部通知（含已撤成误报的）。 */
export function alarmsForRecord(recordNo: string): EntryRow[] {
  return listRows(ALARM_KEY).filter((row) => String(row[FIELD_SOURCE] ?? '') === recordNo)
}

/** 仍然有效的关联通知：同条记录反复越线只保留一次触发，靠它挡重复。 */
function activeAlarmFor(recordNo: string): EntryRow | undefined {
  return alarmsForRecord(recordNo).find((row) => String(row.status) !== ALARM_STATUS_FALSE)
}

/** 阈值判定：取「已生效」的雨量阈值配置，逐项比对雨量指标，给出等级与命中原因。 */
export function judgeRainfall(record: EntryRow): RainJudgment {
  const threshold = listRows(THRESHOLD_KEY).find(
    (row) => String(row.status) === '已生效' && String(row['监测类型'] ?? '').includes('雨量'),
  )
  if (!threshold) {
    return {
      crossed: false,
      level: '',
      reasons: ['没有已生效的雨量阈值配置，未做越线判定'],
      thresholdReady: false,
    }
  }
  for (const { level, field } of LEVELS) {
    const limit = toNumber(threshold[field])
    if (limit === null) {
      continue
    }
    const hits = METRICS.flatMap((metric) => {
      const value = toNumber(record[metric])
      return value !== null && value >= limit ? [`${metric}${value}mm≥${level}阈值${limit}mm`] : []
    })
    if (hits.length > 0) {
      return { crossed: true, level, reasons: hits, thresholdReady: true }
    }
  }
  return { crossed: false, level: '', reasons: ['各项雨量指标均未越线'], thresholdReady: true }
}

function nextAlarmId(): number {
  return listRows(ALARM_KEY).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 通知生成：一条记录只落一条有效通知；不同站点各是各的记录，自然分别落账、互不挤占。 */
function buildAlarm(record: EntryRow, judgment: RainJudgment): EntryRow {
  const id = nextAlarmId()
  const recordNo = String(record['记录编号'] ?? '')
  const station = String(record['站点编号'] ?? '')
  return {
    id,
    status: '待发布',
    pending: true,
    abnormal: false,
    通知编号: `ALAR-${String(id).padStart(4, '0')}`,
    隐患点编号: station,
    预警等级: judgment.level || '人工触发',
    触发条件: `雨量记录${recordNo}（站点${station}）${judgment.reasons.join('；') || '人工触发'}`,
    发布时间: nowText(),
    接收单位: '乡镇值班室',
    发布人: '系统自动',
    通知状态: '待发布',
    [FIELD_SOURCE]: recordNo,
  }
}

type RainConclusion = {
  status: string
  triggered: boolean
  abnormal: boolean
  conclusion: string
}

/** 雨量结论回写：状态、触发标记、异常标记、结论一次写齐，不存在写一半的中间态。 */
function writeRainConclusion(rows: EntryRow[], index: number, conclusion: RainConclusion): void {
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: conclusion.status,
    pending: false,
    abnormal: conclusion.abnormal,
    记录状态: conclusion.status,
    [FIELD_TRIGGERED]: conclusion.triggered ? '是' : '否',
    [FIELD_CONCLUSION]: conclusion.conclusion,
  }
  saveRows(RAIN_KEY, next)
}

/** 事务包装：任何一步写失败都回滚三本账，并把失败原因带回给页面。 */
function transact(mutate: () => string): ActionResult {
  try {
    return { ok: true, message: runInTransaction(mutate) }
  } catch (error) {
    return {
      ok: false,
      message: `写入失败，雨量结论、通知清单、异常标记已全部回滚：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 复核：阈值判定 → 写雨量结论 → 越线则生成通知，三步同事务；重复复核幂等，绝不再生成通知。 */
export function reviewRainfall(id: number): ActionResult {
  const rows = listRows(RAIN_KEY)
  const index = findRainIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const record = rows[index]
  const recordNo = String(record['记录编号'] ?? '')
  const status = String(record.status)
  if (status === RAIN_STATUS.abnormal) {
    return { ok: false, message: `雨量记录${recordNo}已是异常值，不参与复核` }
  }
  if (status !== RAIN_STATUS.collected) {
    return {
      ok: true,
      message: `雨量记录${recordNo}已复核过，结论「${String(record[FIELD_CONCLUSION] ?? record.status)}」保持不变，未重复生成通知`,
    }
  }
  const judgment = judgeRainfall(record)
  return transact(() => {
    writeRainConclusion(rows, index, {
      status: judgment.crossed ? RAIN_STATUS.triggered : RAIN_STATUS.reviewed,
      triggered: judgment.crossed,
      abnormal: false,
      conclusion: judgment.crossed ? `达${judgment.level}预警值` : '未达预警值',
    })
    if (!judgment.crossed) {
      return '复核完成：未达预警值，未生成通知'
    }
    const existing = activeAlarmFor(recordNo)
    if (existing) {
      return `复核完成：达${judgment.level}预警值，通知${String(existing['通知编号'])}已存在，未重复生成`
    }
    const alarm = buildAlarm(record, judgment)
    saveRows(ALARM_KEY, [...listRows(ALARM_KEY), alarm])
    return `复核完成：达${judgment.level}预警值，已生成预警通知${String(alarm['通知编号'])}`
  })
}

/** 触发预警：同条记录反复越线只保留一次触发，已有有效通知就直接沿用。 */
export function triggerRainfallAlarm(id: number): ActionResult {
  const rows = listRows(RAIN_KEY)
  const index = findRainIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const record = rows[index]
  const recordNo = String(record['记录编号'] ?? '')
  if (String(record.status) === RAIN_STATUS.abnormal) {
    return { ok: false, message: `雨量记录${recordNo}已是异常值，不能触发预警` }
  }
  const existing = activeAlarmFor(recordNo)
  if (String(record[FIELD_TRIGGERED]) === '是' && existing) {
    return {
      ok: true,
      message: `雨量记录${recordNo}已触发过预警，通知${String(existing['通知编号'])}仍有效，未重复生成`,
    }
  }
  const judgment = judgeRainfall(record)
  return transact(() => {
    writeRainConclusion(rows, index, {
      status: RAIN_STATUS.triggered,
      triggered: true,
      abnormal: false,
      conclusion: judgment.crossed ? `达${judgment.level}预警值` : '人工触发预警',
    })
    if (existing) {
      return `已触发预警，沿用通知${String(existing['通知编号'])}，未重复生成`
    }
    const alarm = buildAlarm(record, judgment)
    saveRows(ALARM_KEY, [...listRows(ALARM_KEY), alarm])
    return `已触发预警并生成通知${String(alarm['通知编号'])}`
  })
}

/** 判异常：雨量结论、通知清单、异常标记同一事务回写，旧触发标记和关联通知一并撤掉。 */
export function markRainfallAbnormal(id: number): ActionResult {
  const rows = listRows(RAIN_KEY)
  const index = findRainIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const record = rows[index]
  const recordNo = String(record['记录编号'] ?? '')
  if (String(record.status) === RAIN_STATUS.abnormal) {
    return { ok: true, message: `雨量记录${recordNo}已是异常值，触发标记与关联通知保持撤销状态` }
  }
  return transact(() => {
    writeRainConclusion(rows, index, {
      status: RAIN_STATUS.abnormal,
      triggered: false,
      abnormal: true,
      conclusion: '人工判异常',
    })
    const withdrawn: string[] = []
    const nextAlarms = listRows(ALARM_KEY).map((row) => {
      if (String(row[FIELD_SOURCE] ?? '') !== recordNo || String(row.status) === ALARM_STATUS_FALSE) {
        return row
      }
      withdrawn.push(String(row['通知编号']))
      return { ...row, status: ALARM_STATUS_FALSE, pending: false, abnormal: true, 通知状态: ALARM_STATUS_FALSE }
    })
    if (withdrawn.length > 0) {
      saveRows(ALARM_KEY, nextAlarms)
    }
    return withdrawn.length > 0
      ? `已判异常并撤掉触发标记，关联通知${withdrawn.join('、')}已撤为误报`
      : '已判异常并撤掉触发标记，无关联通知需要撤销'
  })
}

/** 雨量页动作入口：列表和详情共用，两条路径走同一套事务逻辑。 */
export function runRainfallAction(id: number, action: string): ActionResult {
  switch (action) {
    case '提交审核':
      return reviewRainfall(id)
    case '触发预警':
      return triggerRainfallAlarm(id)
    case '标记异常':
      return markRainfallAbnormal(id)
    default:
      return { ok: false, message: `雨量记录没有登记「${action}」这个动作` }
  }
}
