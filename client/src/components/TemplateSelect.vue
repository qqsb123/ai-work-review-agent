<script setup lang="ts">
defineProps<{
  modelValue: 'concise' | 'detailed' | 'okr'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: 'concise' | 'detailed' | 'okr']
}>()
</script>

<template>
  <el-radio-group
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-radio value="concise">简洁型</el-radio>
    <el-radio value="detailed">详细型</el-radio>
    <el-radio value="okr">OKR 型</el-radio>
  </el-radio-group>
</template>
