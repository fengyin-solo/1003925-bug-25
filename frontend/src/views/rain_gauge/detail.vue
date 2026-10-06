<template>
  <section class="page" data-module="rain_gauge_detail">
    <header class="page-head">
      <div>
        <h2>雨量记录详情</h2>
        <p class="page-desc">同一条记录的阈值判定、通知清单与异常标记在此一并复核；执行动作走同一事务，失败全部撤销。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="goBack">返回列表</button>
        <button class="btn primary" type="button" @click="review">完成复核</button>
        <button class="btn" type="button" @click="markAbnormal">标记异常</button>
      </div>
    </header>

    <div v-if="errorMessage" class="error-text">{{ errorMessage }}</div>

    <template v-if="record">
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">小时最大雨强</span>
          <strong class="stat-value">{{ evaluation.rain.toFixed(1) }} mm</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">命中等级</span>
          <strong class="stat-value">{{ evaluation.level ?? '未越线' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">当前结论</span>
          <strong class="stat-value">{{ record.status }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">异常标记</span>
          <strong class="stat-value">{{ record.abnormal ? '是' : '否' }}</strong>
        </article>
      </div>

      <p v-if="evaluation.thresholds" class="status-legend">
        <span class="legend-item">
          判定依据（站点 {{ record['站点编号'] }} 生效阈值）：
          注意级 ≥{{ evaluation.thresholds.注意级 }}mm / 警示级 ≥{{ evaluation.thresholds.警示级 }}mm / 警戒级 ≥{{ evaluation.thresholds.警戒级 }}mm
        </span>
      </p>
      <p v-else class="error-text">该站点没有生效中的雨量阈值，无法完成复核，请先在预警阈值模块配置并发布。</p>

      <h3>记录字段</h3>
      <table class="data-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th style="width: 160px">{{ field }}</th>
            <td>{{ record[field] ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

      <h3>关联预警通知</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>通知编号</th>
            <th>预警等级</th>
            <th>触发条件</th>
            <th>接收单位</th>
            <th>通知状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="notice in notifications" :key="String(notice.id)">
            <td>{{ notice['通知编号'] }}</td>
            <td>{{ notice['预警等级'] }}</td>
            <td>{{ notice['触发条件'] }}</td>
            <td>{{ notice['接收单位'] }}</td>
            <td>{{ notice.status }}</td>
          </tr>
          <tr v-if="!notifications.length">
            <td colspan="5" class="empty-state">该记录尚未生成预警通知</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
        <span v-else>同条记录反复越线只保留一次有效触发；人工判异常会撤回待发布通知并清掉触发标记。</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { moduleMeta } from '@/api/local-service'
import {
  evaluateLevel,
  markRainRecordsAbnormal,
  notificationsOfRain,
  reviewRainRecords,
  RAIN_KEY,
  THRESHOLD_KEY,
} from '@/domain/rain'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const router = useRouter()
const meta = moduleMeta(RAIN_KEY)

const record = ref<EntryRow | null>(null)
const notifications = ref<EntryRow[]>([])
const errorMessage = ref('')
const noticeMessage = ref('')

const fields = meta.fields
const evaluation = computed(() => {
  if (!record.value) {
    return { rain: 0, level: null as string | null, thresholds: null }
  }
  return evaluateLevel(record.value, listRows(THRESHOLD_KEY))
})

function load() {
  const id = Number(route.params.id)
  record.value = listRows(RAIN_KEY).find((row) => Number(row.id) === id) ?? null
  if (!record.value) {
    errorMessage.value = `没有找到编号为 ${id} 的雨量记录`
    return
  }
  notifications.value = notificationsOfRain(String(record.value['记录编号']))
}

function goBack() {
  router.push({ name: 'rain_gauge' })
}

function review() {
  if (!record.value) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = reviewRainRecords([Number(record.value.id)])
    const parts = [
      `结论「${result.items[0]?.level ? '达预警值' : '已审核'}」`,
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
      parts.push('重复复核未再生成通知')
    }
    noticeMessage.value = parts.join('，')
    load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '复核失败，事务已全部撤销'
  }
}

function markAbnormal() {
  if (!record.value) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = markRainRecordsAbnormal([Number(record.value.id)])
    const parts = [`异常标记已回写`, `撤回待发布通知 ${result.withdrawn} 张`]
    if (result.unchanged) {
      parts.push('该记录已是异常值，未重复回写')
    }
    noticeMessage.value = parts.join('，')
    load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '标记异常失败，事务已全部撤销'
  }
}

onMounted(load)
</script>

<style scoped>
h3 {
  margin: 18px 0 8px;
  font-size: 15px;
}
.notice-text {
  color: #0b7a3b;
}
</style>
