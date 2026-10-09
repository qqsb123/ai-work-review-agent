<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { getAgentData, retryAgentRun, type AgentRun } from '../api/agentRuns'
import type { AgentTraceEvent } from '../api/sse'

const emit = defineEmits<{ recover: [task: string, result: Record<string, unknown>] }>()
const runs = ref<AgentRun[]>([])
const selected = ref<AgentRun | null>(null)
const events = ref<AgentTraceEvent[]>([])
const error = ref('')
const busy = ref(false)
let controller: AbortController | null = null
const lifecycle = new AbortController()
let selection = 0
const taskLabels: Record<string, string> = { insights: '趋势复盘', plans: '计划跟踪', clarification: '智能追问' }
const stageLabels: Record<string, string> = {
  started: '任务开始', run_started: '载入执行预算', model_start: '请求模型决策', model_end: '模型返回决策',
  tool_start: '调用工具', tool_end: '工具返回', tool_validation_error: '工具参数校验失败',
  validation_error: '证据校验失败', validation_passed: '证据校验通过', run_completed: '任务完成',
  run_stopped: '任务停止', result_received: '结果已接收', thinking: '分析已有证据', tool: '处理工具',
  validating: '校验证据', repairing: '修订引用'
}
const statusLabels: Record<string, string> = { pending: '待执行', running: '执行中', succeeded: '已完成',
  failed: '失败', aborted: '已中断', timed_out: '超时', validation_error: '校验失败' }
async function refresh() {
  try {
    const data = await getAgentData<{ data: AgentRun[] }>('/api/ai/runs', lifecycle.signal)
    if (!lifecycle.signal.aborted) { runs.value = data.data; error.value = '' }
  } catch (e) { if (!lifecycle.signal.aborted) error.value = e instanceof Error ? e.message : '读取失败' }
}
async function open(runId: string) {
  const revision = ++selection
  error.value = ''
  try {
    const run = await getAgentData<AgentRun>(`/api/ai/runs/${encodeURIComponent(runId)}`, lifecycle.signal)
    if (lifecycle.signal.aborted || revision !== selection) return
    selected.value = run; events.value = run.events || []
  } catch (e) { if (!lifecycle.signal.aborted) error.value = e instanceof Error ? e.message : '读取失败' }
}
function receive(event: Event) {
  const entry = (event as CustomEvent<AgentTraceEvent>).detail
  if (!entry.runId) return
  if (!selected.value || (entry.stage === 'started' && !busy.value)) {
    selection++
    selected.value = { runId: entry.runId, task: 'agent', status: 'running', attempt: entry.attempt || 1, createdAt: entry.timestamp || '' }
    events.value = []
  }
  if (entry.runId === selected.value.runId) events.value.push(entry)
  if (entry.stage === 'result_received') { void refresh(); void open(entry.runId) }
}
async function retry() {
  if (!selected.value || busy.value) return
  const run = selected.value
  controller = new AbortController(); busy.value = true; error.value = ''; events.value = []
  let pending: Record<string, unknown> | null = null
  await retryAgentRun(run.runId, result => { pending = result }, message => { error.value = message }, controller.signal)
  if (!controller.signal.aborted && !error.value && pending) emit('recover', run.task, pending)
  busy.value = false; controller = null
  if (!lifecycle.signal.aborted) { await refresh(); await open(run.runId) }
}
function stop() { controller?.abort() }
onMounted(() => { window.addEventListener('agent-event', receive); void refresh() })
onBeforeUnmount(() => { window.removeEventListener('agent-event', receive); lifecycle.abort(); controller?.abort() })
</script>

<template>
  <section class="card agent-trace-card">
    <div class="history-title-row">
      <div><h2 class="card-title">执行轨迹与任务恢复</h2><p class="section-desc">查看模型决策、检索、原文读取及证据校验。中断后从原始输入重新执行，最多三次尝试。</p></div>
      <el-button :disabled="busy" @click="refresh">刷新记录</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="trace-layout">
      <div class="trace-runs">
        <el-empty v-if="!runs.length" description="暂无已保存的执行记录" />
        <button v-for="run in runs" :key="run.runId" class="trace-run" :class="{ selected: selected?.runId === run.runId }" :disabled="busy" @click="open(run.runId)">
          <strong>{{ taskLabels[run.task] || run.task }}</strong><span>{{ statusLabels[run.status] || run.status }} · 第 {{ run.attempt }} 次</span>
          <small>{{ new Date(run.createdAt).toLocaleString('zh-CN') }}</small>
        </button>
      </div>
      <div class="trace-detail">
        <template v-if="selected">
          <p class="section-desc">运行标识：{{ selected.runId }} · {{ statusLabels[selected.status] || selected.status }}</p>
          <div class="inline-actions">
            <el-button v-if="selected.status === 'succeeded' && selected.result" type="primary" plain @click="emit('recover', selected.task, selected.result)">恢复结果</el-button>
            <el-button v-else :loading="busy" :disabled="selected.attempt >= 3 || (selected.status === 'running' && (!selected.leaseUntil || new Date(selected.leaseUntil).getTime() > Date.now()))" @click="retry">安全重新执行</el-button>
            <el-button v-if="busy" type="danger" plain @click="stop">停止执行</el-button>
          </div>
          <p v-if="selected.errorCode" class="section-desc">停止原因：{{ selected.errorCode }}</p>
          <ol class="trace-events" aria-live="polite">
            <li v-for="(event, index) in events" :key="index">
              <div><strong>{{ stageLabels[event.stage] || event.stage }}</strong><small>第 {{ event.attempt || 1 }} 次 · {{ event.elapsedMs ?? 0 }} ms</small></div>
              <p v-if="event.message">{{ event.message }}</p>
              <details v-if="event.meta"><summary>执行详情</summary><pre>{{ JSON.stringify(event.meta, null, 2) }}</pre></details>
            </li>
          </ol>
        </template>
        <el-empty v-else description="运行任务或选择一条记录查看轨迹" />
      </div>
    </div>
  </section>
</template>
