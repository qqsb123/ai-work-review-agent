<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import ReportForm from './components/ReportForm.vue'
import ReportResult from './components/ReportResult.vue'
import LoginForm from './components/LoginForm.vue'
import { deleteReport, getReports, updateReport, type Report } from './api/reports'
import { generateInsights, rewriteReport, type RewriteMode } from './api/ai'

const result = ref('')
const loading = ref(false)
const controller = ref<AbortController | null>(null)
const isLoggedIn = ref(!!localStorage.getItem('token'))
const reports = ref<Report[]>([])
const historyLoading = ref(false)
const detailVisible = ref(false)
const editing = ref(false)
const selectedReport = ref<Report | null>(null)
const editContent = ref('')

const rewriteLoading = ref(false)
const rewriteController = ref<AbortController | null>(null)
const insights = ref('')
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
  insights.value = ''
  detailVisible.value = false
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
  try {
    reports.value = await getReports()
  } catch (error) {
    console.error('加载历史周报失败:', error)
  } finally {
    historyLoading.value = false
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
  insights.value = ''

  let content = ''
  await generateInsights(
    (chunk) => {
      content += chunk
      insights.value = content
    },
    () => {
      insightsLoading.value = false
      insightsController.value = null
    },
    (message) => ElMessage.error(message),
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
  } catch (error: any) {
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
  return marked.parse(content || '') as string
}

onMounted(() => {
  window.addEventListener('auth-expired', handleAuthExpired)
  if (isLoggedIn.value) loadReports()
})

onBeforeUnmount(() => {
  window.removeEventListener('auth-expired', handleAuthExpired)
  controller.value?.abort()
  rewriteController.value?.abort()
  insightsController.value?.abort()
})

function handleStart() {
  loading.value = true
}

async function handleDone() {
  loading.value = false
  controller.value = null
  await loadReports()
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
  <main class="page">
    <div class="container">
      <header class="hero hero-row">
        <div>
          <div class="title-badges">
            <h1>AI 智能工作复盘平台</h1>
            <el-tag type="success" effect="dark">Portfolio Edition</el-tag>
          </div>
          <p>AI 流式生成、历史上下文增强、多用户数据隔离与工作趋势复盘。</p>
        </div>
        <el-button v-if="isLoggedIn" @click="logout()">退出登录</el-button>
      </header>

      <LoginForm v-if="!isLoggedIn" @success="handleLoginSuccess" />

      <div v-else>
        <div class="grid">
          <ReportForm
            v-model="result"
            :loading="loading"
            @start="handleStart"
            @done="handleDone"
            @controller="handleController"
          />
          <ReportResult :content="result" :loading="loading" @stop="stopGenerate" />
        </div>

        <section class="card insight-card">
          <div class="history-title-row">
            <div>
              <h2 class="card-title">AI 工作趋势洞察</h2>
              <p class="section-desc">基于最近 6 份历史周报分析工作主线、计划承接和反复问题。</p>
            </div>
            <div class="inline-actions">
              <el-button v-if="insightsLoading" type="danger" plain @click="stopInsights">停止分析</el-button>
              <el-button type="primary" :loading="insightsLoading" @click="runInsights">
                {{ insights ? '重新分析' : '生成趋势洞察' }}
              </el-button>
            </div>
          </div>

          <el-empty v-if="!insights && !insightsLoading" description="至少积累 2 份周报后，可生成跨周趋势复盘" />
          <div v-else class="markdown-content" v-html="renderMarkdown(insights)" />
        </section>

        <section class="history card">
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
