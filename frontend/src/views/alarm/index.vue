<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">维护预警通知，围绕通知编号、隐患点编号、预警等级、触发条件做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警通知</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无预警发布数据，可先登记预警通知</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { subscribe } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('alarm')
const columns = ["通知编号", "隐患点编号", "预警等级", "触发条件", "发布时间", "接收单位", "发布人", "通知状态"]
const actions = ["确认发布", "登记响应", "解除预警"]
const statuses = ["待发布", "已发布", "已响应", "已解除", "误报"]

const rows = ref<EntryRow[]>([])
// 未加筛选条件的全量通知清单，统计卡以它为准。
const ledger = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthCount = ledger.value.filter((row) => String(row['发布时间'] ?? '').startsWith(month)).length
  const responded = ledger.value.filter((row) => String(row.status) === '已响应').length
  const open = ledger.value.filter((row) => !['已解除', '误报'].includes(String(row.status))).length
  return [
    { label: '本月预警数', value: String(monthCount) },
    { label: '已响应数', value: String(responded) },
    { label: '未解除数', value: String(open) },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '预警通知登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
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
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  reload()
  // 雨量链路生成或撤销通知时会落账，工作台订阅后同步刷新，不用重新进页面。
  unsubscribe = subscribe(() => reload())
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
