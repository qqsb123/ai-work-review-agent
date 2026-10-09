<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { trackPlans, type PlanResult, type PlanStatus, type ReportEvidence } from '../api/ai'
import type { Report } from '../api/reports'
import EvidenceDialog from './EvidenceDialog.vue'

const props = defineProps<{ reports: Report[]; restored?: PlanResult | null }>()
const reportId = ref<number | undefined>()
const result = ref<PlanResult | null>(null)
watch(() => props.restored, value => { if (value && !loading.value) { result.value = value; error.value = '' } })
const loading = ref(false)
const progress = ref('')
const error = ref('')
const evidence = ref<ReportEvidence | null>(null)
let controller: AbortController | null = null
const labels: Record<PlanStatus, string> = { completed: '已完成', in_progress: '进行中', blocked: '阻塞', unconfirmed: '无法确认' }
const colors = { completed: 'success', in_progress: 'primary', blocked: 'danger', unconfirmed: 'info' } as const

async function analyze() {
  if (loading.value) return
  const current = new AbortController()
  controller = current
  loading.value = true; result.value = null; error.value = ''; evidence.value = null; progress.value = '正在开始计划分析'
  let pending: PlanResult | null = null
  await trackPlans(reportId.value, data => { pending = data }, event => { if (!current.signal.aborted) progress.value = event.message },
    () => {}, message => { if (!current.signal.aborted) error.value = message }, current.signal)
  if (controller !== current) return
  if (!current.signal.aborted && !error.value) result.value = pending
  progress.value = current.signal.aborted ? '已停止分析' : ''
  loading.value = false; controller = null
}
function stop() { controller?.abort() }
onBeforeUnmount(stop)
</script>

<template>
  <section class="card insight-card">
    <div class="history-title-row">
      <div><h2 class="card-title">计划持续跟踪</h2><p class="section-desc">从历史计划查找后续证据。未提到某项计划，不代表未完成。</p></div>
      <div class="inline-actions">
        <el-button v-if="loading" type="danger" plain @click="stop">停止分析</el-button>
        <el-button type="primary" :loading="loading" @click="analyze">分析计划状态</el-button>
      </div>
    </div>
    <div class="agent-focus">
      <el-select v-model="reportId" clearable :disabled="loading" placeholder="默认：最近两份有计划的记录" style="width: min(100%, 380px)">
        <el-option v-for="report in reports.filter(report => report.next_plan?.trim())" :key="report.id" :value="report.id"
          :label="`周报 #${report.id} · ${new Date(report.created_at).toLocaleDateString('zh-CN')}`" />
      </el-select>
    </div>
    <p v-if="progress" role="status" aria-live="polite" class="agent-progress">{{ progress }}</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-empty v-if="!loading && !error && (!result || !result.plans.length)" :description="result ? '选定记录没有可分析的计划' : '选择历史计划，查看基于证据的状态建议'" />
    <template v-if="result">
      <el-alert v-for="limitation in result.limitations" :key="limitation" :title="limitation" type="info" :closable="false" class="agent-limitation" />
      <article v-for="plan in result.plans" :key="plan.planId" class="plan-item">
        <div class="history-title-row"><strong>{{ plan.text }}</strong><el-tag :type="colors[plan.status]">{{ labels[plan.status] }}</el-tag></div>
        <p>{{ plan.reason }}</p>
        <p class="section-desc">计划来源：周报 #{{ plan.reportId }}；本次检索到 {{ plan.reviewedReportIds.length }} 份后续记录。</p>
        <div class="agent-evidence-links">
          <el-button v-for="(entry, index) in plan.evidence" :key="index" link type="primary" @click="evidence = entry">
            {{ entry.field === 'next_plan' ? '查看原计划' : '查看后续依据' }} #{{ entry.reportId }}
          </el-button>
        </div>
      </article>
      <EvidenceDialog :evidence="evidence" :sources="result.sources" @close="evidence = null" />
    </template>
  </section>
</template>
