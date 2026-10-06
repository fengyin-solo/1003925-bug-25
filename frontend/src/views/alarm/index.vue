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
          <th>来源雨量记录</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <button
              v-if="row['来源记录编号']"
              class="link"
              type="button"
              @click="openSource(row)"
            >
              {{ row['来源记录编号'] }}
            </button>
            <span v-else>人工登记</span>
          </td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无预警发布数据，可先登记预警通知</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { RAIN_KEY } from '@/domain/rain'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('alarm')
const columns = ["通知编号", "隐患点编号", "预警等级", "触发条件", "发布时间", "接收单位", "发布人", "通知状态"]
const actions = ["确认发布", "登记响应", "解除预警"]
const statuses = ["待发布", "已发布", "已响应", "已解除", "误报"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 工作台统计实时来自最新通知清单：雨量复核/判异常后回到此页立刻反映最新状态。
const stats = computed(() => {
  const totalCount = rows.value.length
  const responded = rows.value.filter((row) =>
    ['已响应', '已解除'].includes(String(row.status)),
  ).length
  const unresolved = rows.value.filter((row) =>
    ['待发布', '已发布', '已响应'].includes(String(row.status)),
  ).length
  const fromRain = rows.value.filter((row) => String(row['来源模块'] ?? '') === RAIN_KEY).length
  return [
    { label: '通知总数', value: totalCount },
    { label: '已响应/解除', value: responded },
    { label: '未解除', value: unresolved },
    { label: '雨量自动触发', value: fromRain },
  ]
})

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

function openSource(row: EntryRow) {
  if (String(row['来源模块'] ?? '') !== RAIN_KEY) {
    return
  }
  const code = String(row['来源记录编号'] ?? '')
  const source = listRows(RAIN_KEY).find((item) => String(item['记录编号']) === code)
  if (source) {
    router.push({ name: 'rain_detail', params: { id: String(source.id) } })
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
  }
}

onMounted(reload)
</script>
