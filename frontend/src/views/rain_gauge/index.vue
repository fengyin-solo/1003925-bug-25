<template>
  <section class="page" data-module="rain_gauge">
    <header class="page-head">
      <div>
        <h2>雨量监测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记雨量记录</button>
        <button class="btn" type="button" @click="exportRows">导出雨量监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无雨量监测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条雨量监测记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="detail-mask" @click.self="closeDetail">
      <div class="detail-panel" role="dialog" aria-label="雨量记录详情">
        <button class="btn ghost detail-close" type="button" @click="closeDetail">关闭</button>
        <h3>雨量记录详情 · {{ detailRow['记录编号'] }}</h3>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
          <dt>异常标记</dt>
          <dd>{{ detailRow.abnormal ? '是' : '否' }}</dd>
        </dl>
        <section class="detail-block">
          <h4>阈值判定</h4>
          <p v-if="detailJudge">
            {{ detailJudge.crossed ? `越线：${detailJudge.level}` : '未越线' }}
            <span v-if="detailJudge.reasons.length">（{{ detailJudge.reasons.join('；') }}）</span>
          </p>
        </section>
        <section class="detail-block">
          <h4>关联预警通知（{{ detailAlarms.length }} 条，同条记录只保留一次触发）</h4>
          <table v-if="detailAlarms.length" class="data-table">
            <thead>
              <tr><th>通知编号</th><th>预警等级</th><th>通知状态</th><th>发布时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="alarm in detailAlarms" :key="String(alarm.id)">
                <td>{{ alarm['通知编号'] }}</td>
                <td>{{ alarm['预警等级'] }}</td>
                <td>{{ alarm.status }}</td>
                <td>{{ alarm['发布时间'] }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else>暂无关联通知</p>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { alarmsForRecord, judgeRainfall, runRainfallAction } from '@/api/rainfall-service'
import { subscribe } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rain_gauge')
const columns = ["记录编号", "站点编号", "观测时段", "时段雨量", "日累计雨量", "小时最大雨强", "是否触发预警", "记录状态"]
const actions = ["提交审核", "触发预警", "标记异常"]
const statuses = ["已采集", "已审核", "达预警值", "异常值"]

const rows = ref<EntryRow[]>([])
// 未加筛选条件的全量台账：统计卡和详情都从这里取，避免筛选条件让两处数量对不上。
const ledger = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const stations = new Set(ledger.value.map((row) => String(row['站点编号'] ?? '')).filter(Boolean))
  const triggered = ledger.value.filter((row) => String(row['是否触发预警']) === '是').length
  const rainSum = ledger.value.reduce((sum, row) => sum + (Number(row['时段雨量']) || 0), 0)
  return [
    { label: '雨量站点数', value: String(stations.size) },
    { label: '达预警值站次', value: String(triggered) },
    { label: '累计降雨量', value: `${rainSum.toFixed(1)}mm` },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const detailId = ref<number | null>(null)
const detailRow = computed(() => ledger.value.find((row) => Number(row.id) === detailId.value) ?? null)
const detailJudge = computed(() => (detailRow.value ? judgeRainfall(detailRow.value) : null))
const detailAlarms = computed(() =>
  detailRow.value ? alarmsForRecord(String(detailRow.value['记录编号'] ?? '')) : [],
)

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '雨量记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  // 复核、触发、判异常都走雨量领域服务：结论、通知、异常标记在一个事务里落账。
  const result = runRainfallAction(Number(row.id), action)
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量监测列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  reload()
  unsubscribe = subscribe(() => reload())
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
