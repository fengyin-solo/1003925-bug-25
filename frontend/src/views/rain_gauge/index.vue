<template>
  <section class="page" data-module="rain_gauge">
    <header class="page-head">
      <div>
        <h2>雨量监测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转。复核即按生效阈值判定，命中自动生成预警通知。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="batchReview">
          批量复核{{ selectedIds.length ? `（${selectedIds.length}）` : '' }}
        </button>
        <button class="btn" type="button" :disabled="!selectedIds.length" @click="batchAbnormal">
          批量判异常{{ selectedIds.length ? `（${selectedIds.length}）` : '' }}
        </button>
        <button class="btn ghost" type="button" @click="exportRows">导出雨量监测清单</button>
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

    <p class="status-legend">
      <span v-for="item in thresholdCards" :key="item.station" class="legend-item">
        雨量阈值 · {{ item.station === 'ALL' ? '全局' : `站点 ${item.station}` }}：
        注意级 ≥{{ item.thresholds.注意级 }}mm / 警示级 ≥{{ item.thresholds.警示级 }}mm / 警戒级 ≥{{ item.thresholds.警戒级 }}mm
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
          <th style="width: 36px"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td><input type="checkbox" :checked="isSelected(row)" @change="toggleOne(row)" /></td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="reviewOne(row)">完成复核</button>
            <button class="link" type="button" @click="markOneAbnormal(row)">标记异常</button>
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无雨量监测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条雨量监测记录，已选 {{ selectedIds.length }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  effectiveRainThresholds,
  markRainRecordsAbnormal,
  reviewRainRecords,
} from '@/domain/rain'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('rain_gauge')
const columns = ["记录编号", "站点编号", "观测时段", "时段雨量", "日累计雨量", "小时最大雨强", "是否触发预警", "记录状态"]
const statuses = ["已采集", "已审核", "达预警值", "异常值"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<Set<number>>(new Set())

const thresholdCards = effectiveRainThresholds()

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const stations = new Set(rows.value.map((row) => String(row['站点编号'] ?? '')))
  const triggered = rows.value.filter((row) => String(row['是否触发预警']) === '是').length
  const rainfall = rows.value.reduce((sum, row) => sum + Number(row['时段雨量'] || 0), 0)
  const pendingReview = rows.value.filter((row) => String(row.status) === '已采集').length
  const abnormal = rows.value.filter((row) => row.abnormal).length
  return [
    { label: '雨量站点数', value: stations.size },
    { label: '达预警值站次', value: triggered },
    { label: '累计时段雨量(mm)', value: rainfall.toFixed(1) },
    { label: '待复核', value: pendingReview },
    { label: '异常记录', value: abnormal },
  ]
})

const selectedRows = computed(() =>
  rows.value.filter((row) => selected.value.has(Number(row.id))),
)
const selectedIds = computed(() => selectedRows.value.map((row) => Number(row.id)))
const allSelected = computed(
  () => rows.value.length > 0 && selectedRows.value.length === rows.value.length,
)

function isSelected(row: EntryRow) {
  return selected.value.has(Number(row.id))
}

function toggleOne(row: EntryRow) {
  const next = new Set(selected.value)
  const id = Number(row.id)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selected.value = next
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selected.value = checked ? new Set(rows.value.map((row) => Number(row.id))) : new Set()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow) {
  router.push({ name: 'rain_detail', params: { id: String(row.id) } })
}

function describeReview(ids: number[]) {
  const result = reviewRainRecords(ids)
  const parts = [
    `复核 ${result.reviewed + result.unchanged} 条`,
    `命中 ${result.triggered} 站次`,
    `新建通知 ${result.created} 张`,
    `复用既有触发 ${result.reused} 张`,
  ]
  if (result.withdrawn) {
    parts.push(`撤回待发布通知 ${result.withdrawn} 张`)
  }
  if (result.deduped) {
    parts.push(`合并重复触发 ${result.deduped} 张`)
  }
  if (result.unchanged) {
    parts.push(`重复复核 ${result.unchanged} 条（未重复生成通知）`)
  }
  return parts.join('，')
}

function describeMark(ids: number[]) {
  const result = markRainRecordsAbnormal(ids)
  const parts = [`标记异常 ${result.marked} 条`, `撤回待发布通知 ${result.withdrawn} 张`]
  if (result.deduped) {
    parts.push(`合并重复触发 ${result.deduped} 张`)
  }
  if (result.unchanged) {
    parts.push(`重复判异常 ${result.unchanged} 条（幂等未重复回写）`)
  }
  return parts.join('，')
}

function runBatch(action: () => string, ids: number[]) {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    noticeMessage.value = action()
    selected.value = new Set()
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败，已全部撤销'
    reload()
  }
}

function batchReview() {
  runBatch(() => describeReview(selectedIds.value), selectedIds.value)
}

function batchAbnormal() {
  runBatch(() => describeMark(selectedIds.value), selectedIds.value)
}

function reviewOne(row: EntryRow) {
  runBatch(() => describeReview([Number(row.id)]), [Number(row.id)])
}

function markOneAbnormal(row: EntryRow) {
  runBatch(() => describeMark([Number(row.id)]), [Number(row.id)])
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const visibleIds = new Set(rows.value.map((row) => Number(row.id)))
    selected.value = new Set([...selected.value].filter((id) => visibleIds.has(id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.notice-text {
  color: #0b7a3b;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
