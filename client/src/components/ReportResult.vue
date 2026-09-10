<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import { ElMessage } from 'element-plus'
import html2pdf from 'html2pdf.js'

const props = defineProps<{
  content: string
  loading: boolean
}>()

const emit = defineEmits<{
  stop: []
}>()

const html = computed(() => marked.parse(props.content || ''))

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
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
      <h2 class="card-title" style="margin-bottom:0;">AI 生成结果</h2>

      <div style="display:flex;gap:8px;">
        <el-button v-if="loading" type="danger" plain @click="emit('stop')">
          停止生成
        </el-button>
        <el-button v-if="content" @click="copyContent">
          复制
        </el-button>
        <el-button v-if="content" @click="exportPdf">
          导出 PDF
        </el-button>
      </div>
    </div>

    <div v-if="content" id="result-content" class="result-body" v-html="html" />
    <div v-else class="result-placeholder">
      {{ loading ? 'AI 正在生成，请稍候...' : '填写左侧内容后开始生成' }}
    </div>
  </section>
</template>
