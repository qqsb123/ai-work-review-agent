<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import TemplateSelect from './TemplateSelect.vue'
import { createWeeklyReport, type WeeklyReportPayload } from '../api/weeklyReport'

const emit = defineEmits<{
  'update:modelValue': [value: string]
  start: []
  done: []
  controller: [value: AbortController | null]
}>()

defineProps<{
  modelValue: string
  loading: boolean
}>()

const work = ref('')
const problems = ref('')
const nextPlan = ref('')
const style = ref<WeeklyReportPayload['style']>('detailed')
const useHistory = ref(true)

async function generate() {
  if (!work.value.trim()) {
    ElMessage.warning('请先填写本周工作内容')
    return
  }

  const controller = new AbortController()
  emit('controller', controller)
  emit('update:modelValue', '')
  emit('start')

  let accumulated = ''

  await createWeeklyReport(
    {
      work: work.value.trim(),
      problems: problems.value.trim(),
      nextPlan: nextPlan.value.trim(),
      style: style.value,
      useHistory: useHistory.value
    },
    (content) => {
      accumulated += content
      emit('update:modelValue', accumulated)
    },
    () => {
      emit('done')
      emit('controller', null)
    },
    (message) => ElMessage.error(message),
    controller.signal
  )
}
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
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="例如：完成权限模块，继续学习 Node.js..."
      />
    </div>

    <div class="form-item">
      <label>生成风格</label>
      <TemplateSelect v-model="style" />
    </div>

    <div class="context-option">
      <div>
        <strong>参考最近 3 份历史周报</strong>
        <p>用于识别工作连续性和承接上周计划，不会把旧成果冒充成本周成果。</p>
      </div>
      <el-switch v-model="useHistory" />
    </div>

    <div class="actions">
      <el-button type="primary" :loading="loading" @click="generate">
        {{ loading ? '生成中...' : '生成周报' }}
      </el-button>
    </div>
  </section>
</template>
