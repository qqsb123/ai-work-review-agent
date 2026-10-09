<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { safeMarkdown } from './utils/safeMarkdown'
import ReportForm from './components/ReportForm.vue'
import ReportResult from './components/ReportResult.vue'
import LoginForm from './components/LoginForm.vue'
import InsightsResultView from './components/InsightsResult.vue'
import PlanTracker from './components/PlanTracker.vue'
import AgentTrace from './components/AgentTrace.vue'
import BrandLogo from './components/BrandLogo.vue'
import { getAgentData } from './api/agentRuns'
import { confirmWeeklyReport, type GeneratedDraft, type PreparedDraft, type WeeklyReportPayload } from './api/weeklyReport'
import { deleteReport, getReports, updateReport, type Report } from './api/reports'
import { generateInsights, rewriteReport, type RewriteMode, type InsightsResult, type PlanResult } from './api/ai'

const pages = [
  { id: 'weekly', title: '周报生成', description: '整理本周工作，检查并确认你的周报。' },
  { id: 'insights', title: '工作趋势', description: '结合历史原文，回顾工作主线与反复出现的问题。' },
  { id: 'plans', title: '计划跟踪', description: '核对后续记录，查看历史计划的推进情况。' },
  { id: 'history', title: '历史周报', description: '查看、编辑和管理已确认保存的周报。' },
  { id: 'runs', title: '执行记录', description: '查看任务过程，恢复结果或重新执行中断的任务。' },
] as const
type PageId = typeof pages[number]['id']
function pageFromHash(): PageId {
  const id = window.location.hash.slice(1)
  return pages.find(page => page.id === id)?.id || 'weekly'
}
const activePage = ref<PageId>(pageFromHash())
function syncPage() { activePage.value = pageFromHash() }
function navigate(page: PageId) {
  activePage.value = page
  window.location.hash = page
}

const result = ref('')
const formRef = ref<InstanceType<typeof ReportForm> | null>(null)
const restoredPlans = ref<PlanResult | null>(null)
const reportDraft = ref<GeneratedDraft | null>(null)
const draftSaving = ref(false)
const draftSaved = ref(false)
const draftSaveError = ref('')
const loading = ref(false)
const controller = ref<AbortController | null>(null)
const isLoggedIn = ref(!!localStorage.getItem('token'))
const reports = ref<Report[]>([])
const historyLoading = ref(false)
let historyRequest = 0
const detailVisible = ref(false)
const editing = ref(false)
const selectedReport = ref<Report | null>(null)
const editContent = ref('')

const rewriteLoading = ref(false)
const rewriteController = ref<AbortController | null>(null)
const insights = ref<InsightsResult | null>(null)
const insightsQuestion = ref('')
const insightsProgress = ref('')
const insightsError = ref('')
const insightsLoading = ref(false)
const insightsController = ref<AbortController | null>(null)

function handleLoginSuccess() {
  isLoggedIn.value = true
  loadReports()
}

function clearSessionState() {
  controller.value?.abort()
  rewriteController.value?.abort()
  insightsController.value?.abort()
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  isLoggedIn.value = false
  reports.value = []
  result.value = ''
  reportDraft.value = null
  draftSaved.value = false
  draftSaveError.value = ''
  insights.value = null
  restoredPlans.value = null
  insightsQuestion.value = ''
  insightsProgress.value = ''
  insightsError.value = ''
  detailVisible.value = false
  selectedReport.value = null
  editContent.value = ''
  historyRequest++
}

function logout(message = '已退出登录') {
  clearSessionState()
  ElMessage.success(message)
}

function handleAuthExpired() {
  if (!isLoggedIn.value) return
  clearSessionState()
  ElMessage.warning('登录已过期，请重新登录')
}

async function loadReports() {
  if (!isLoggedIn.value) return
  historyLoading.value = true
  const currentRequest = ++historyRequest
  const currentToken = localStorage.getItem('token')
  try {
    const loaded = await getReports()
    if (isLoggedIn.value && currentRequest === historyRequest && localStorage.getItem('token') === currentToken) reports.value = loaded
  } catch (error) {
    console.error('加载历史周报失败:', error)
  } finally {
    if (currentRequest === historyRequest) historyLoading.value = false
  }
}

function openDetail(report: Report) {
  selectedReport.value = { ...report }
  editContent.value = report.content
  editing.value = false
  detailVisible.value = true
}

async function saveEdit() {
  if (!selectedReport.value || !editContent.value.trim()) {
    ElMessage.warning('周报内容不能为空')
    return
  }

  try {
    await updateReport(selectedReport.value.id, editContent.value.trim())
    selectedReport.value.content = editContent.value.trim()
    editing.value = false
    await loadReports()
    ElMessage.success('周报已更新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '修改失败')
  }
}

async function runRewrite(mode: RewriteMode) {
  if (!selectedReport.value || rewriteLoading.value) return

  rewriteController.value?.abort()
  const currentController = new AbortController()
  rewriteController.value = currentController
  rewriteLoading.value = true
  editing.value = true

  const source = editContent.value.trim() || selectedReport.value.content
  let rewritten = ''
  editContent.value = ''

  await rewriteReport(
    selectedReport.value.id,
    source,
    mode,
    (chunk) => {
      rewritten += chunk
      editContent.value = rewritten
    },
    () => {
      rewriteLoading.value = false
      rewriteController.value = null
    },
    (message) => ElMessage.error(message),
    currentController.signal
  )
}

function stopRewrite() {
  rewriteController.value?.abort()
}

async function runInsights() {
  if (insightsLoading.value) return

  const currentController = new AbortController()
  insightsController.value = currentController
  insightsLoading.value = true
  insights.value = null
  insightsProgress.value = '正在开始复盘...'
  insightsError.value = ''

  let pendingResult: InsightsResult | null = null
  await generateInsights(
    insightsQuestion.value.trim(),
    (result) => {
      if (!currentController.signal.aborted) pendingResult = result
    },
    (event) => {
      if (!currentController.signal.aborted) insightsProgress.value = event.message
    },
    () => {
      if (insightsController.value !== currentController) return
      if (!currentController.signal.aborted && !insightsError.value) insights.value = pendingResult
      insightsProgress.value = currentController.signal.aborted ? '已停止分析' : ''
      insightsLoading.value = false
      insightsController.value = null
    },
    (message) => {
      if (currentController.signal.aborted) return
      insightsError.value = message
      ElMessage.error(message)
    },
    currentController.signal
  )
}

function stopInsights() {
  insightsController.value?.abort()
}

async function removeReport(report: Report) {
  try {
    await ElMessageBox.confirm('删除后无法恢复，确定删除这份周报吗？', '删除周报', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await deleteReport(report.id)
    if (selectedReport.value?.id === report.id) detailVisible.value = false
    await loadReports()
    ElMessage.success('删除成功')
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function styleName(style: Report['style']) {
  return ({ concise: '简洁', detailed: '详细', okr: 'OKR' } as const)[style] || style
}

function renderMarkdown(content: string) {
  return safeMarkdown(content)
}

onMounted(() => {
  window.addEventListener('auth-expired', handleAuthExpired)
  window.addEventListener('hashchange', syncPage)
  if (isLoggedIn.value) loadReports()
})

onBeforeUnmount(() => {
  window.removeEventListener('auth-expired', handleAuthExpired)
  window.removeEventListener('hashchange', syncPage)
  controller.value?.abort()
  rewriteController.value?.abort()
  insightsController.value?.abort()
})

function handleStart() {
  loading.value = true
  reportDraft.value = null
  draftSaved.value = false
  draftSaveError.value = ''
}

async function handleDone() {
  loading.value = false
  controller.value = null
}

function handleDraft(draft: GeneratedDraft) { reportDraft.value = draft }

async function recoverAgentResult(task: string, saved: Record<string, unknown>) {
  if (loading.value || insightsLoading.value || draftSaving.value) { ElMessage.info('请先完成或停止当前任务'); return }
  if (task === 'insights') { insights.value = saved as unknown as InsightsResult; insightsError.value = ''; navigate('insights'); return }
  if (task === 'plans') { restoredPlans.value = saved as unknown as PlanResult; navigate('plans'); return }
  if (task === 'clarification' && typeof saved.sessionId === 'string') {
    const token = localStorage.getItem('token')
    try {
      const draft = await getAgentData<PreparedDraft & GeneratedDraft & { input: WeeklyReportPayload; state: string }>(`/api/weekly-report/drafts/${encodeURIComponent(saved.sessionId)}`)
      if (!isLoggedIn.value || token !== localStorage.getItem('token')) return
      if (draft.state === 'ready' || draft.state === 'saved') {
        result.value = draft.content; reportDraft.value = draft; draftSaved.value = draft.state === 'saved'; draftSaveError.value = ''
      } else if (draft.state === 'prepared') formRef.value?.restore(draft)
      else ElMessage.info('草稿仍在生成，异常中断后请等待四分钟再恢复')
      if (['ready', 'saved', 'prepared'].includes(draft.state)) navigate('weekly')
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '恢复失败') }
  }
}

async function saveDraft() {
  if (!reportDraft.value || draftSaving.value || draftSaved.value) return
  const currentDraft = reportDraft.value
  draftSaving.value = true
  draftSaveError.value = ''
  try {
    await confirmWeeklyReport(currentDraft)
    if (reportDraft.value === currentDraft && isLoggedIn.value) {
      draftSaved.value = true
      await loadReports()
      ElMessage.success('周报已确认保存')
    }
  } catch (error: unknown) { draftSaveError.value = error instanceof Error ? error.message : '保存失败，请重试' }
  finally { draftSaving.value = false }
}

function handleController(value: AbortController | null) {
  controller.value = value
}

function stopGenerate() {
  controller.value?.abort()
  loading.value = false
  controller.value = null
}
</script>

<template>
  <main class="page" :class="{ 'login-page': !isLoggedIn }">
    <div class="container">
      <header v-if="isLoggedIn" class="hero hero-row">
        <div>
          <h1 class="workspace-brand-heading"><BrandLogo /></h1>
          <p class="workspace-tagline">记录工作，回看进展。</p>
        </div>
        <el-button v-if="isLoggedIn" @click="logout()">退出登录</el-button>
      </header>

      <LoginForm v-if="!isLoggedIn" @success="handleLoginSuccess" />

      <div v-else>
        <nav class="workspace-nav" aria-label="功能导航">
          <a v-for="page in pages" :key="page.id" :href="`#${page.id}`"
            :class="{ active: activePage === page.id }" :aria-current="activePage === page.id ? 'page' : undefined">
            {{ page.title }}
            <span v-if="page.id === 'weekly' && loading" class="nav-running">生成中</span>
            <span v-if="page.id === 'insights' && insightsLoading" class="nav-running">分析中</span>
          </a>
        </nav>
        <div class="workspace-heading">
          <h2>{{ pages.find(page => page.id === activePage)?.title }}</h2>
          <p>{{ pages.find(page => page.id === activePage)?.description }}</p>
        </div>

        <div v-show="activePage === 'weekly'" class="grid workspace-panel">
          <ReportForm
            ref="formRef"
            v-model="result"
            :loading="loading || draftSaving"
            @start="handleStart"
            @done="handleDone"
            @controller="handleController"
            @draft="handleDraft"
          />
          <div>
            <ReportResult :content="result" :loading="loading" :ready="!!reportDraft" @stop="stopGenerate" />
            <div v-if="reportDraft" class="card draft-confirmation">
              <el-alert v-if="reportDraft.factCheckFallback" title="模型草稿未通过事实校验，已改为保留原始信息的保守整理稿。" type="info" :closable="false" />
              <p>{{ draftSaved ? '这份周报已保存到历史记录。' : '这是待确认草稿，尚未写入历史。检查后点击确认保存。' }}</p>
              <el-alert v-if="draftSaveError" :title="draftSaveError" type="error" :closable="false" />
              <el-button type="primary" :loading="draftSaving" :disabled="draftSaved || loading" @click="saveDraft">
                {{ draftSaved ? '已保存' : '确认保存到历史' }}
              </el-button>
            </div>
          </div>
        </div>

        <section v-show="activePage === 'insights'" class="card insight-card workspace-panel">
          <div class="history-title-row">
            <div>
              <h2 class="card-title">Agent 工作趋势复盘</h2>
              <p class="section-desc">查找相关历史记录、核对原文，分析工作主线、计划承接和反复问题。</p>
            </div>
            <div class="inline-actions">
              <el-button v-if="insightsLoading" type="danger" plain @click="stopInsights">停止分析</el-button>
              <el-button type="primary" :loading="insightsLoading" @click="runInsights">
                {{ insights ? '重新分析' : '生成趋势洞察' }}
              </el-button>
            </div>
          </div>

          <div class="form-item agent-focus">
            <label>复盘重点（可选）</label>
            <el-input v-model="insightsQuestion" :disabled="insightsLoading" maxlength="1000"
              placeholder="例如：权限模块推进情况，以及反复出现的阻塞" />
          </div>
          <p v-if="insightsProgress" role="status" aria-live="polite" class="agent-progress">{{ insightsProgress }}</p>
          <el-alert v-if="insightsError" :title="insightsError" type="error" :closable="false" />
          <el-empty v-if="!insights && !insightsLoading && !insightsError" description="至少积累 2 份周报后，可生成带原文依据的趋势复盘" />
          <InsightsResultView v-if="insights" :result="insights" />
        </section>

        <div v-show="activePage === 'plans'" class="workspace-panel">
          <PlanTracker :reports="reports" :restored="restoredPlans" />
        </div>
        <div v-show="activePage === 'runs'" class="workspace-panel">
          <AgentTrace @recover="recoverAgentResult" />
        </div>

        <section v-show="activePage === 'history'" class="history card workspace-panel">
          <div class="history-title-row">
            <div>
              <h2 class="card-title">历史周报</h2>
              <p class="section-desc">当前账号共 {{ reports.length }} 份记录，所有读写操作均按用户身份隔离。</p>
            </div>
            <el-button :loading="historyLoading" @click="loadReports">刷新</el-button>
          </div>

          <el-empty v-if="!historyLoading && reports.length === 0" description="暂无历史周报" />

          <div v-else class="history-list">
            <article v-for="report in reports" :key="report.id" class="history-item">
              <div class="history-meta">
                <el-tag size="small">{{ styleName(report.style) }}</el-tag>
                <span>{{ formatDate(report.created_at) }}</span>
              </div>
              <p>{{ report.content }}</p>
              <div class="history-actions">
                <el-button link type="primary" @click="openDetail(report)">查看 / AI 编辑</el-button>
                <el-button link type="danger" @click="removeReport(report)">删除</el-button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="周报详情与 AI 编辑" width="min(820px, 94vw)">
      <template v-if="selectedReport">
        <div class="detail-meta">
          <el-tag>{{ styleName(selectedReport.style) }}</el-tag>
          <span>{{ formatDate(selectedReport.created_at) }}</span>
        </div>

        <div class="ai-toolbar">
          <span class="toolbar-label">AI 二次编辑</span>
          <el-button size="small" :disabled="rewriteLoading" @click="runRewrite('professional')">专业化</el-button>
          <el-button size="small" :disabled="rewriteLoading" @click="runRewrite('concise')">精简</el-button>
          <el-button size="small" :disabled="rewriteLoading" @click="runRewrite('okr')">OKR 化</el-button>
          <el-button v-if="rewriteLoading" size="small" type="danger" plain @click="stopRewrite">停止</el-button>
        </div>

        <el-alert
          v-if="rewriteLoading"
          title="AI 正在流式重写，完成后可检查结果并手动保存。"
          type="info"
          :closable="false"
          show-icon
          class="rewrite-alert"
        />

        <el-input
          v-if="editing"
          v-model="editContent"
          type="textarea"
          :autosize="{ minRows: 14, maxRows: 26 }"
        />
        <div v-else class="markdown-content detail-content" v-html="renderMarkdown(selectedReport.content)" />
      </template>

      <template #footer>
        <el-button v-if="!editing" @click="editing = true">手动编辑</el-button>
        <template v-else>
          <el-button
            :disabled="rewriteLoading"
            @click="editing = false; editContent = selectedReport?.content || ''"
          >
            取消
          </el-button>
          <el-button type="primary" :disabled="rewriteLoading" @click="saveEdit">保存到数据库</el-button>
        </template>
      </template>
    </el-dialog>
  </main>
</template>
