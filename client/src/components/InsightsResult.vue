<script setup lang="ts">
import { computed, ref } from 'vue'
import type { InsightsResult } from '../api/ai'

const props = defineProps<{ result: InsightsResult }>()
const evidenceVisible = ref(false)
const selectedEvidence = ref<{ reportId: number; quote: string } | null>(null)
const selectedSource = computed(() => props.result.sources.find(source => source.id === selectedEvidence.value?.reportId))

function formatDate(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function showEvidence(evidence: { reportId: number; quote: string }) {
  selectedEvidence.value = evidence
  evidenceVisible.value = true
}
</script>

<template>
  <div class="agent-result">
    <el-alert v-for="limitation in result.limitations" :key="limitation" :title="limitation"
      type="info" :closable="false" class="agent-limitation" />
    <section v-for="section in result.sections" :key="section.key" class="agent-section">
      <h3>{{ section.title }}</h3>
      <p v-if="!section.items.length" class="section-desc">现有证据不足，暂不下结论。</p>
      <ul v-else class="agent-claims">
        <li v-for="(item, index) in section.items" :key="index">
          <p class="agent-claim-text">{{ item.text }}</p>
          <div class="agent-evidence-links">
            <el-button v-for="(evidence, evidenceIndex) in item.evidence" :key="evidenceIndex"
              link type="primary" @click="showEvidence(evidence)">
              查看依据 #{{ evidence.reportId }}
            </el-button>
          </div>
        </li>
      </ul>
    </section>
    <p class="section-desc">本次读取了 {{ result.sources.length }} 份正文。展示的原文引用已核对，结论是否充分仍请结合实际工作确认。</p>

    <el-dialog v-model="evidenceVisible" title="本次分析的原文依据" width="min(820px, 94vw)">
      <template v-if="selectedEvidence">
        <p>周报 #{{ selectedEvidence.reportId }} · 创建时间：
          {{ formatDate(selectedSource?.createdAt) }}
        </p>
        <p class="section-desc">这是本次读取的正文快照，之后修改周报不会改变本次依据。</p>
        <blockquote class="agent-quote">{{ selectedEvidence.quote }}</blockquote>
        <p v-if="selectedSource?.truncated" class="section-desc">
          正文超过 6000 字，本次只读取前 6000 字。
        </p>
        <pre class="agent-source">{{ selectedSource?.content }}</pre>
      </template>
    </el-dialog>
  </div>
</template>
