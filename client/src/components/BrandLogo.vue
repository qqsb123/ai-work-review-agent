<script setup lang="ts">
defineProps<{ large?: boolean }>()
</script>

<template>
  <span class="brand-logo" :class="{ 'brand-logo-large': large }" role="img" aria-label="工作复盘 WORK NOTES">
    <svg class="brand-logo-mark" viewBox="0 0 40 44" fill="none" aria-hidden="true">
      <path d="M11 5h24v31H11z" stroke="currentColor" stroke-width="1.8" />
      <path d="M17 13h12M17 20h12M17 27h6" stroke="currentColor" stroke-width="1.8" />
      <path d="M5 12v30h24" stroke="currentColor" stroke-width="1.8" />
    </svg>
    <span class="brand-logo-type"><span class="brand-logo-name">工作复盘<span class="brand-logo-period">.</span></span><span class="brand-logo-caption">WORK NOTES</span></span>
  </span>
</template>

<style scoped>
.brand-logo { display: inline-flex; align-items: center; gap: 13px; color: #254c3c; }
.brand-logo-mark { width: 39px; height: 43px; flex-shrink: 0; }
.brand-logo-type { display: flex; flex-direction: column; gap: 5px; }
.brand-logo-name { font: 600 27px/1.15 "Noto Serif SC", "Songti SC", "SimSun", serif; letter-spacing: 3px; white-space: nowrap; }
.brand-logo-period { color: #a66843; letter-spacing: 0; }
.brand-logo-caption { font: 500 9px/1.3 Inter, sans-serif; letter-spacing: 3.5px; color: #68776c; }
.brand-logo-large { gap: 17px; }
.brand-logo-large .brand-logo-mark { width: 55px; height: 61px; }
.brand-logo-large .brand-logo-name { font-size: 40px; letter-spacing: 4px; }
.brand-logo-large .brand-logo-caption { font-size: 10px; letter-spacing: 5px; }
@media (max-width: 640px) {
  .brand-logo-large .brand-logo-name { font-size: 31px; letter-spacing: 3px; }
  .brand-logo-large .brand-logo-mark { width: 44px; height: 50px; }
  .brand-logo-large { gap: 13px; }
}
</style>
