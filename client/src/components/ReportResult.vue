<script setup lang="ts">
import { computed } from 'vue'
import { safeMarkdown } from '../utils/safeMarkdown'
import { ElMessage } from 'element-plus'
import html2pdf from 'html2pdf.js'

const props = defineProps<{
  content: string
  loading: boolean
  ready?: boolean
}>()

const emit = defineEmits<{
  stop: []
}>()

const html = computed(() => safeMarkdown(props.content))

async function copyContent() {
  if (!props.content) return
  await navigator.clipboard.writeText(props.content)
  ElMessage.success('周报已复制')
}

async function exportPdf() {
  const element = document.querySelector('#result-content') as HTMLElement | null
  if (!element || !props.content) return

  await html2pdf()
    .set({
      margin: 10,
      filename: `AI周报-${new Date().toISOString().slice(0, 10)}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    })
    .from(element)
    .save()

  ElMessage.success('PDF 导出成功')
}
</script>

<template>
  <section class="card result">
    <div class="card-heading-row result-heading">
      <h2 class="card-title">周报预览</h2>

      <div class="inline-actions result-actions">
        <el-button v-if="loading" type="danger" plain @click="emit('stop')">
          停止生成
        </el-button>
        <el-button v-if="content" :disabled="loading || !ready" @click="copyContent">
          复制
        </el-button>
        <el-button v-if="content" :disabled="loading || !ready" @click="exportPdf">
          导出 PDF
        </el-button>
      </div>
    </div>

    <p v-if="content && !ready" class="section-desc">当前为生成预览，只有完整生成并通过校验后才可保存、复制或导出。</p>
    <div v-if="content" id="result-content" class="result-body" v-html="html" />
    <div v-else class="result-placeholder">
      <div class="result-empty-note">
        <svg viewBox="0 0 48 56" fill="none" aria-hidden="true"><path d="M9 4h30v42H9zM4 12v40h29M16 15h16M16 23h16M16 31h10" stroke="currentColor" stroke-width="1.5" /></svg>
        <p>{{ loading ? '正在整理本周记录…' : '给这一周，留一份记录。' }}</p>
        <span>{{ loading ? '生成的内容将逐步显示在这里。' : '填写工作、问题与计划，生成后在这里检查并确认。' }}</span>
      </div>
    </div>
  </section>
</template>
