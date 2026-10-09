<script setup lang="ts">
import { computed } from 'vue'
import type { ReportEvidence, ReportSource } from '../api/ai'

const props = defineProps<{ evidence: ReportEvidence | null; sources: ReportSource[] }>()
const emit = defineEmits<{ close: [] }>()
const source = computed(() => props.sources.find(source => source.id === props.evidence?.reportId))
const fieldLabel = computed(() => ({ content: '已保存周报正文', work_content: '用户工作输入', next_plan: '原始下周计划' }[props.evidence?.field || 'content']))
const body = computed(() => {
  if (props.evidence?.field === 'next_plan') return source.value?.nextPlan
  if (props.evidence?.field === 'work_content') return source.value?.workContent
  return source.value?.content
})
function date(value: string | undefined) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '' }
</script>

<template>
  <el-dialog :model-value="!!evidence" @update:model-value="emit('close')" title="本次分析的原文依据" width="min(820px, 94vw)">
    <template v-if="evidence">
      <p>周报 #{{ evidence.reportId }} · {{ fieldLabel }} · 创建：{{ date(source?.createdAt) }}</p>
      <p class="section-desc">本次读取的字段快照。原计划引用只证明计划存在，不代表已完成。</p>
      <blockquote class="agent-quote">{{ evidence.quote }}</blockquote>
      <p v-if="source?.truncated" class="section-desc">长正文已截断，仅已读取部分属于本次证据。</p>
      <pre class="agent-source">{{ body }}</pre>
    </template>
  </el-dialog>
</template>
