import { listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ALARM_KEY,
  markRainRecordsAbnormal,
  notificationsOfRain,
  RAIN_KEY,
  reviewRainRecords,
  THRESHOLD_KEY,
} from '@/domain/rain'
import type { EntryRow } from '@/data/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function reset() {
  resetRows(RAIN_KEY)
  resetRows(ALARM_KEY)
  resetRows(THRESHOLD_KEY)
}

function rainByCode(code: string) {
  return listRows(RAIN_KEY).find((row) => String(row['记录编号']) === code)!
}

function activeAlarms(code: string) {
  return notificationsOfRain(code).filter((row) => !['误报', '已解除'].includes(String(row.status)))
}

// 用例 1：两个站点同时命中，同一事务分别落账
reset()
{
  const summary = reviewRainRecords([1, 2])
  check('双站同审：复核 2 条', summary.reviewed === 2, JSON.stringify(summary))
  check('双站同审：各命中 1 站次（共 2）', summary.triggered === 2)
  check('双站同审：分别新建 2 张通知', summary.created === 2)
  const a1 = activeAlarms('RAIN-0001')
  const a2 = activeAlarms('RAIN-0002')
  check('RAIN-0001 落账 1 张（ST-001 全局阈值 → 注意级 26.4≥20）', a1.length === 1 && a1[0]['预警等级'] === '注意级', JSON.stringify(a1))
  check('RAIN-0002 落账 1 张（ST-002 专属阈值 → 警示级 45.2≥38）', a2.length === 1 && a2[0]['预警等级'] === '警示级', JSON.stringify(a2))
  check('两条通知站点编号各自独立', String(a1[0]['隐患点编号']) === 'ST-001' && String(a2[0]['隐患点编号']) === 'ST-002')
  check('雨量结论同步为达预警值/触发标记为是', rainByCode('RAIN-0001').status === '达预警值' && rainByCode('RAIN-0001')['是否触发预警'] === '是')
}

// 用例 2：同条记录反复越线，重复复核不再生成通知
{
  const again = reviewRainRecords([1])
  check('重复复核：结论不变计入 unchanged', again.unchanged === 1, JSON.stringify(again))
  check('重复复核：新建 0 张，复用 1 张', again.created === 0 && again.reused === 1)
  check('RAIN-0001 仍只有 1 张有效通知', activeAlarms('RAIN-0001').length === 1)

  const third = reviewRainRecords([1, 2])
  check('批量重复复核：两记录共复用 2 张、新建 0', third.reused === 2 && third.created === 0 && third.unchanged === 2, JSON.stringify(third))
}

// 用例 3：人工判异常——撤结论、清触发标记、撤回待发布通知
{
  const result = markRainRecordsAbnormal([1])
  const rain = rainByCode('RAIN-0001')
  check('判异常：标记 1 条', result.marked === 1, JSON.stringify(result))
  check('判异常：撤回待发布通知 1 张', result.withdrawn === 1)
  check('雨量结论为异常值且 abnormal=true', rain.status === '异常值' && rain.abnormal === true)
  check('旧触发标记“是否触发预警”被清为否', rain['是否触发预警'] === '否')
  check('该记录已无有效通知', activeAlarms('RAIN-0001').length === 0)
  const all = notificationsOfRain('RAIN-0001')
  check('撤回的通知落为误报', all.length === 1 && all[0].status === '误报')

  const again = markRainRecordsAbnormal([1])
  check('重复判异常幂等：marked=0、unchanged=1', again.marked === 0 && again.unchanged === 1, JSON.stringify(again))
}

// 用例 4：未越线记录复核不生成通知
{
  const summary = reviewRainRecords([3])
  const rain = rainByCode('RAIN-0003')
  check('未越线：结论为已审核', rain.status === '已审核' && summary.triggered === 0)
  check('未越线：不生成通知', notificationsOfRain('RAIN-0003').length === 0)
  check('未越线：触发标记为否', rain['是否触发预警'] === '否')
}

// 用例 5：事务失败整体回滚（混入不存在的记录 id）
reset()
{
  let threw = false
  try {
    reviewRainRecords([3, 9999])
  } catch (error) {
    threw = true
  }
  check('复核含无效 id 时抛错', threw)
  const rain = rainByCode('RAIN-0003')
  check('整批回滚：同批有效记录仍是已采集', rain.status === '已采集' && rain['是否触发预警'] === '否', rain.status)
  check('整批回滚：未留下任何通知', listRows(ALARM_KEY).filter((row) => String(row['来源记录编号']) === 'RAIN-0003').length === 0)
}

// 用例 6：异常值记录不允许直接复核（事务回滚保护）
{
  let threw = false
  try {
    reviewRainRecords([6])
  } catch {
    threw = true
  }
  check('异常值记录复核被拒绝', threw)
  check('异常值记录保持原状', rainByCode('RAIN-0006').status === '异常值')
}

// 用例 7：历史脏数据——同一记录残留多张重复触发，复核时自动对账去重
reset()
{
  reviewRainRecords([2])
  const base = activeAlarms('RAIN-0002')[0]
  const alarms = listRows(ALARM_KEY)
  const extras: EntryRow[] = [
    {
      ...base,
      id: 901,
      通知编号: 'ALAR-0901',
      status: '待发布',
      pending: true,
      abnormal: false,
      通知状态: '待发布',
    },
    {
      ...base,
      id: 902,
      通知编号: 'ALAR-0902',
      status: '待发布',
      pending: true,
      abnormal: false,
      通知状态: '待发布',
    },
  ]
  saveRows(ALARM_KEY, [...alarms, ...extras])
  check('造脏：RAIN-0002 有 3 张有效通知', activeAlarms('RAIN-0002').length === 3)

  const summary = reviewRainRecords([2])
  check('对账：合并重复触发 2 张', summary.deduped === 2 && summary.created === 0, JSON.stringify(summary))
  const remaining = activeAlarms('RAIN-0002')
  check('对账后只保留最早 1 张有效触发', remaining.length === 1 && String(remaining[0].id) === String(base.id))
  const falseAlarms = notificationsOfRain('RAIN-0002').filter((row) => row.status === '误报')
  check('多余通知回写为误报并保留台账', falseAlarms.length === 2)
}

// 用例 8：缺阈值时整批回滚
{
  saveRows(
    THRESHOLD_KEY,
    listRows(THRESHOLD_KEY).filter((row) => String(row['隐患点编号']) !== 'ALL'),
  )
  saveRows(RAIN_KEY, [
    ...listRows(RAIN_KEY),
    {
      id: 99,
      status: '已采集',
      pending: true,
      abnormal: false,
      记录编号: 'RAIN-0099',
      站点编号: 'ST-NONE',
      观测时段: '2026-10-06 10:00-11:00',
      时段雨量: 80,
      日累计雨量: 80,
      小时最大雨强: 80,
      是否触发预警: '否',
      记录状态: '已采集',
    },
  ])
  let threw = false
  try {
    reviewRainRecords([99, 3])
  } catch {
    threw = true
  }
  check('无生效阈值时抛错', threw)
  check('无阈值回滚：同批另一记录未被改动', rainByCode('RAIN-0003').status === '已采集')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
