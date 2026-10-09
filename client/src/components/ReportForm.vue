<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import TemplateSelect from './TemplateSelect.vue'
import { prepareWeeklyReport, generatePreparedReport, type WeeklyReportPayload, type PreparedDraft, type GeneratedDraft } from '../api/weeklyReport'

const emit = defineEmits<{
  'update:modelValue': [value: string]
  start: []
  done: []
  controller: [value: AbortController | null]
  draft: [value: GeneratedDraft]
}>()
const props = defineProps<{ modelValue: string; loading: boolean }>()
const work = ref('')
const problems = ref('')
const nextPlan = ref('')
const style = ref<WeeklyReportPayload['style']>('detailed')
const useHistory = ref(true)
const prepared = ref<PreparedDraft | null>(null)
const answers = ref<Record<string, string>>({})
const progress = ref('')
const error = ref('')
const questions = computed(() => prepared.value?.questions || [])
const frozen = computed(() => props.loading || questions.value.length > 0)
let active: AbortController | null = null

function begin() {
  const current = new AbortController()
  active = current
  error.value = ''
  emit('controller', current)
  emit('update:modelValue', '')
  emit('start')
  return current
}
function finish(current: AbortController) {
  if (active !== current) return
  if (current.signal.aborted) progress.value = '已停止，未保存周报'
  else progress.value = ''
  active = null
  emit('controller', null)
  emit('done')
}
function fail(message: string) { error.value = message; ElMessage.error(message) }

async function generateDraft(current: AbortController, session: PreparedDraft, skip: boolean) {
  progress.value = '正在生成周报草稿'
  let accumulated = ''
  let candidate: GeneratedDraft | null = null
  await generatePreparedReport({ sessionId: session.sessionId, skipClarification: skip,
    answers: skip ? [] : session.questions.map(question => ({ questionId: question.id, value: answers.value[question.id] || '' })) },
    chunk => { if (!current.signal.aborted) { accumulated += chunk; emit('update:modelValue', accumulated) } },
    result => { candidate = result }, fail, current.signal)
  if (!current.signal.aborted && !error.value && candidate) {
    const draft: GeneratedDraft = candidate
    emit('update:modelValue', draft.content)
    emit('draft', draft)
    prepared.value = null
    answers.value = {}
  }
}

async function generate() {
  if (props.loading || active) return
  if (!work.value.trim()) { ElMessage.warning('请先填写本周工作内容'); return }
  const current = begin()
  prepared.value = null
  answers.value = {}
  progress.value = '正在检查信息是否充分'
  let response: PreparedDraft | null = null
  try {
    await prepareWeeklyReport({ work: work.value.trim(), problems: problems.value.trim(), nextPlan: nextPlan.value.trim(), style: style.value, useHistory: useHistory.value },
      result => { response = result }, event => { if (!current.signal.aborted) progress.value = event.message }, fail, current.signal)
    if (current.signal.aborted || error.value || !response) return
    const session: PreparedDraft = response
    prepared.value = session
    if (!session.questions.length) await generateDraft(current, session, false)
  } finally { finish(current) }
}

async function resume(skip: boolean) {
  if (!prepared.value || props.loading || active) return
  if (!skip && !Object.values(answers.value).some(answer => answer.trim())) { ElMessage.warning('请填写补充信息，或选择跳过追问'); return }
  const session = prepared.value
  const current = begin()
  try { await generateDraft(current, session, skip) }
  finally { finish(current) }
}
function resetQuestions() { prepared.value = null; answers.value = {}; error.value = '' }
function restore(session: PreparedDraft & { input: WeeklyReportPayload }) {
  if (props.loading || active) return
  work.value = session.input.work; problems.value = session.input.problems; nextPlan.value = session.input.nextPlan
  style.value = session.input.style; useHistory.value = session.input.useHistory
  prepared.value = session; answers.value = {}; error.value = ''
  progress.value = '已恢复草稿会话，可以继续生成'
}
defineExpose({ restore })
onBeforeUnmount(() => { active?.abort() })
</script>

<template>
  <section class="card">
    <div class="card-heading-row">
      <h2 class="card-title">填写本周内容</h2>
      <el-tag type="success" effect="plain">AI + 历史上下文</el-tag>
    </div>

    <div class="form-item">
      <label>本周工作 / 学习内容</label>
      <el-input
        v-model="work"
        :disabled="frozen"
        type="textarea"
        :rows="7"
        maxlength="3000"
        show-word-limit
        placeholder="例如：完成用户登录模块、文章管理功能，学习 Axios 拦截器..."
      />
    </div>

    <div class="form-item">
      <label>遇到的问题</label>
      <el-input
        v-model="problems"
        :disabled="frozen"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="例如：对 Token 过期处理不熟悉..."
      />
    </div>

    <div class="form-item">
      <label>下周计划</label>
      <el-input
        v-model="nextPlan"
        :disabled="frozen"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="例如：完成权限模块，继续学习 Node.js..."
      />
    </div>

    <div class="form-item">
      <label>生成风格</label>
      <TemplateSelect v-model="style" :disabled="frozen" />
    </div>

    <div class="context-option">
      <div>
        <strong>参考最近 3 份历史周报</strong>
        <p>用于识别工作连续性和承接上周计划，不会把旧成果冒充成本周成果。</p>
      </div>
      <el-switch v-model="useHistory" :disabled="frozen" />
    </div>

    <p v-if="progress" role="status" aria-live="polite" class="agent-progress">{{ progress }}</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <section v-if="prepared" class="clarification-panel">
      <h3>{{ questions.length ? '补充少量关键信息' : '继续已恢复的草稿' }}</h3>
      <p class="section-desc">保持同一份输入继续生成。未回答的问题会保留为待确认。</p>
      <div v-for="question in questions" :key="question.id" class="form-item">
        <label :for="`answer-${question.id}`">{{ question.question }}</label>
        <el-input :id="`answer-${question.id}`" v-model="answers[question.id]" :disabled="loading" type="textarea" :rows="2" maxlength="1000" show-word-limit />
      </div>
      <div class="actions wrap-actions">
        <el-button v-if="questions.length" type="primary" :loading="loading" @click="resume(false)">补充后生成</el-button>
        <el-button :disabled="loading" @click="resume(true)">跳过追问，直接生成</el-button>
        <el-button link :disabled="loading" @click="resetQuestions">返回修改输入</el-button>
      </div>
    </section>
    <div v-else class="actions">
      <el-button type="primary" :loading="loading" @click="generate">
        {{ loading ? '处理中...' : '检查信息并生成周报' }}
      </el-button>
    </div>
  </section>
</template>
