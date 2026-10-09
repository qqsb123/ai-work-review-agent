<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import BrandLogo from './BrandLogo.vue'

const username = ref('')
const password = ref('')
const loading = ref(false)
const isRegister = ref(false)
const errorMessage = ref('')

const emit = defineEmits<{
  success: []
}>()

async function submit() {
  if (loading.value) return
  errorMessage.value = ''
  if (!username.value.trim() || !password.value) {
    errorMessage.value = '请填写用户名和密码。'
    return
  }

  loading.value = true

  try {
    const url = isRegister.value
      ? '/api/auth/register'
      : '/api/auth/login'

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value
      })
    })

    const result = await response.json()

    if (!response.ok) {
      throw new Error(
        result.message ||
        (isRegister.value ? '注册失败' : '登录失败')
      )
    }

    if (isRegister.value) {
      ElMessage.success('注册成功，请登录')

      isRegister.value = false
      password.value = ''
    } else {
      localStorage.setItem('token', result.data.token)
      localStorage.setItem(
        'user',
        JSON.stringify(result.data.user)
      )

      emit('success')
      ElMessage.success('登录成功')
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : (isRegister.value ? '注册失败' : '登录失败')

    errorMessage.value = message
  } finally {
    loading.value = false
  }
}

function toggleMode() {
  if (loading.value) return
  isRegister.value = !isRegister.value
  username.value = ''
  password.value = ''
  errorMessage.value = ''
}
</script>

<template>
  <section class="auth-layout" aria-label="登录与注册">
    <header class="auth-masthead">
      <BrandLogo large />
      <span class="auth-masthead-note">记录 · 回顾 · 向前</span>
    </header>

    <div class="auth-body">
      <div class="auth-story">
        <div class="auth-eyebrow"><span></span> 给每一周，留一个清晰的注脚</div>
        <h1>做过的事，<br />值得<span class="auth-title-accent">好好回看。</span></h1>
        <p class="auth-story-description">从零散记录到一份周报，从本周工作到长期主线。<br class="auth-desktop-break" />把进展写清楚，也让下一步更有方向。</p>

        <div class="auth-paper-scene" aria-label="周报示例展示">
          <div class="auth-paper-back" aria-hidden="true"></div>
          <article class="auth-paper">
            <div class="auth-paper-top"><span>一周工作手记</span><span class="auth-example-label">示例</span></div>
            <div class="auth-paper-title">小进展，也有迹可循。</div>
            <div class="auth-note-row"><span class="auth-note-number">01</span><div><strong>本周工作</strong><p>完成登录流程，补齐异常处理。</p></div><span class="auth-note-dot"></span></div>
            <div class="auth-note-row"><span class="auth-note-number">02</span><div><strong>问题与思考</strong><p>记录卡点，留下解决问题的线索。</p></div></div>
            <div class="auth-note-row"><span class="auth-note-number">03</span><div><strong>下一步</strong><p>继续完善权限模块与测试。</p></div></div>
            <div class="auth-paper-bottom"><span>写下来，才看得见变化。</span><svg viewBox="0 0 44 16" fill="none" aria-hidden="true"><path d="M1 8h39M34 2l7 6-7 6" stroke="currentColor" stroke-width="1.5" /></svg></div>
          </article>
          <div class="auth-paper-caption"><span>一份周报，是一条连续的成长线索。</span><span>WEEK / NOTES</span></div>
        </div>
      </div>

      <div class="auth-entry">
        <div class="auth-mode-switch" aria-label="选择登录或注册">
          <button type="button" :class="{ selected: !isRegister }" :aria-pressed="!isRegister" :disabled="loading" @click="isRegister && toggleMode()">登录</button>
          <button type="button" :class="{ selected: isRegister }" :aria-pressed="isRegister" :disabled="loading" @click="!isRegister && toggleMode()">注册</button>
        </div>
        <div class="auth-entry-heading">
          <span class="auth-entry-kicker">你的工作，值得记录</span>
          <h2>{{ isRegister ? '从这一周开始。' : '欢迎回来。' }}</h2>
          <p>{{ isRegister ? '创建账号，建立属于自己的工作记录。' : '登录后，继续你的工作记录与复盘。' }}</p>
        </div>
        <form class="auth-form" :aria-busy="loading" @submit.prevent="submit">
          <div class="auth-field">
            <label for="auth-username">用户名</label>
            <el-input id="auth-username" v-model="username" autocomplete="username" placeholder="输入你的用户名" :disabled="loading" :aria-describedby="errorMessage ? 'auth-error' : undefined" />
          </div>
          <div class="auth-field">
            <label for="auth-password">密码</label>
            <el-input id="auth-password" v-model="password" type="password" show-password :autocomplete="isRegister ? 'new-password' : 'current-password'" :placeholder="isRegister ? '设置你的密码' : '输入你的密码'" :disabled="loading" :aria-describedby="errorMessage ? 'auth-error' : undefined" />
          </div>
          <p v-if="errorMessage" id="auth-error" class="auth-error" role="alert">{{ errorMessage }}</p>
          <button class="auth-submit" type="submit" :disabled="loading">
            <span>{{ loading ? (isRegister ? '正在创建账号…' : '正在登录…') : (isRegister ? '创建账号' : '进入工作台') }}</span>
            <svg v-if="!loading" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" /></svg>
            <span v-else class="auth-spinner" aria-hidden="true"></span>
          </button>
        </form>
        <p class="auth-mode-hint">{{ isRegister ? '已有账号？' : '第一次来？' }}<button type="button" :disabled="loading" @click="toggleMode">{{ isRegister ? '返回登录' : '创建一个账号' }}</button></p>
        <div class="auth-entry-footer"><span class="auth-footer-rule"></span><p>记录属于你，节奏也由你决定。</p></div>
      </div>
    </div>

    <footer class="auth-footer"><span>AI 智能工作复盘平台</span><span>把一周的忙碌，变成看得见的积累。</span></footer>
  </section>
</template>

<style scoped>
.auth-layout { color: #263b32; --auth-green: #254c3c; }
.auth-masthead { display: flex; justify-content: space-between; align-items: center; padding-bottom: 26px; border-bottom: 1px solid #deded4; }
.auth-masthead-note { font-size: 12px; color: #69786c; letter-spacing: 3px; }
.auth-body { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, .85fr); gap: clamp(32px, 6vw, 90px); align-items: center; padding: 58px 0 54px; }
.auth-eyebrow { display: flex; align-items: center; gap: 9px; font-size: 12px; color: #68776c; letter-spacing: 1px; }
.auth-eyebrow > span { width: 7px; height: 7px; background: #a66843; border-radius: 50%; }
.auth-story h1 { margin: 24px 0 20px; font-family: "Noto Serif SC", "Songti SC", "SimSun", serif; font-size: clamp(38px, 4.3vw, 58px); line-height: 1.45; font-weight: 500; letter-spacing: 2px; }
.auth-title-accent { position: relative; white-space: nowrap; }
.auth-title-accent::after { content: ''; position: absolute; left: 0; right: 5px; bottom: -8px; height: 7px; border-top: 2px solid #aa7650; border-radius: 50%; transform: rotate(-2deg); }
.auth-story-description { margin: 0; color: #68766b; font-size: 14px; line-height: 1.95; }
.auth-paper-scene { position: relative; margin: 34px 20px 0 0; max-width: 480px; }
.auth-paper-back { position: absolute; inset: 7px 1px 35px; border: 1px solid #dcdccb; background: #e8ebdf; transform: rotate(-3deg); }
.auth-paper { position: relative; padding: 23px 27px 19px; background: #fffef9; border: 1px solid #e0e1d4; box-shadow: 0 8px 22px #36433308; transform: rotate(1deg); }
.auth-paper-top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #728073; letter-spacing: 1px; }
.auth-example-label { padding: 3px 8px; border: 1px solid #dedfd3; border-radius: 3px; font-size: 10px; }
.auth-paper-title { margin: 17px 0 10px; font-size: 18px; font-family: "Songti SC", "SimSun", serif; }
.auth-note-row { display: flex; align-items: baseline; gap: 14px; padding: 12px 0; border-bottom: 1px solid #edede3; }
.auth-note-number { font-size: 10px; font-family: monospace; color: #a27a59; }
.auth-note-row strong { font-weight: 600; font-size: 12px; }
.auth-note-row p { margin: 5px 0 0; font-size: 11px; line-height: 1.6; color: #778175; }
.auth-note-dot { width: 6px; height: 6px; margin-left: auto; background: #728568; border-radius: 50%; }
.auth-paper-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; font-size: 10px; color: #8a8f7b; }
.auth-paper-bottom svg { width: 36px; height: 14px; }
.auth-paper-caption { display: flex; justify-content: space-between; gap: 12px; margin-top: 23px; color: #7c8477; font-size: 10px; }
.auth-paper-caption span:last-child { letter-spacing: 2px; font-size: 9px; }
.auth-entry { padding: 34px 36px 24px; border: 1px solid #dedfd5; border-radius: 5px; background: #fffefb; box-shadow: 0 16px 42px #39493205; }
.auth-mode-switch { display: flex; width: fit-content; gap: 4px; padding: 4px; border-radius: 5px; background: #f0f1e9; }
.auth-mode-switch button { width: 70px; padding: 7px 12px; border: 0; border-radius: 3px; background: transparent; color: #737f73; cursor: pointer; font-size: 12px; }
.auth-mode-switch button.selected { background: #fffefb; color: #254c3c; box-shadow: 0 1px 4px #293e3110; }
.auth-entry-heading { margin: 32px 0; }
.auth-entry-kicker { color: #9b795a; font-size: 10px; letter-spacing: 2px; }
.auth-entry-heading h2 { margin: 13px 0 10px; font-size: 30px; font-weight: 550; letter-spacing: 1px; }
.auth-entry-heading p { margin: 0; font-size: 12px; color: #738073; line-height: 1.7; }
.auth-field { margin-bottom: 22px; }
.auth-field label { display: block; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: #485b4e; }
.auth-field :deep(.el-input) { --el-input-height: 48px; --el-input-border-color: #dce0d5; --el-input-hover-border-color: #8a9d86; --el-input-focus-border-color: #254c3c; --el-input-bg-color: #fffefb; --el-input-text-color: #263b32; --el-input-placeholder-color: #969d91; }
.auth-field :deep(.el-input__wrapper) { border-radius: 4px; padding: 1px 14px; }
.auth-field :deep(.el-input__inner) { font-size: 13px; }
.auth-submit { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 15px 18px; margin-top: 7px; border: 1px solid var(--auth-green); border-radius: 4px; background: var(--auth-green); color: #fffefb; font-size: 13px; font-weight: 500; cursor: pointer; transition: background .15s; }
.auth-submit:hover { background: #1b3d2e; }
.auth-submit svg { width: 20px; height: 20px; }
.auth-error { margin: -5px 0 15px; color: #a33f32; font-size: 12px; line-height: 1.7; }
.auth-mode-hint { margin: 21px 0 0; text-align: center; font-size: 12px; color: #778375; }
.auth-mode-hint button { padding: 0 0 2px; margin-left: 7px; border: 0; border-bottom: 1px solid #9aaa91; color: #254c3c; background: transparent; font-size: 12px; cursor: pointer; }
.auth-entry-footer { margin-top: 35px; text-align: center; }
.auth-footer-rule { display: block; height: 1px; width: 34px; margin: auto; background: #dce0d3; }
.auth-entry-footer p { font-size: 10px; color: #8c9485; margin: 15px 0 0; }
.auth-footer { display: flex; justify-content: space-between; gap: 12px; padding-top: 20px; border-top: 1px solid #deded4; font-size: 10px; color: #858b7e; }
.auth-layout button:focus-visible { outline: 2px solid #a66843; outline-offset: 4px; }
.auth-layout button:disabled { cursor: wait; opacity: .65; }
.auth-spinner { width: 16px; height: 16px; border: 1.5px solid #ffffff55; border-top-color: #fff; border-radius: 50%; animation: auth-spin .8s linear infinite; }
@keyframes auth-spin { to { transform: rotate(360deg); } }
@media (max-width: 850px) {
  .auth-body { gap: 28px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 40px 0; }
  .auth-story h1 { font-size: 38px; }
  .auth-entry { padding: 28px 24px; }
  .auth-desktop-break { display: none; }
  .auth-paper-caption span:last-child { display: none; }
  .auth-paper { padding: 20px; }
}
@media (max-width: 640px) {
  .auth-masthead { padding-bottom: 20px; }
  .auth-masthead-note { display: none; }
  .auth-body { grid-template-columns: 1fr; padding: 28px 0 30px; gap: 26px; }
  .auth-story h1 { font-size: 34px; margin: 16px 0; }
  .auth-story-description { font-size: 12px; }
  .auth-paper-scene { display: none; }
  .auth-entry { padding: 26px 24px; }
  .auth-entry-heading { margin: 25px 0; }
  .auth-entry-heading h2 { font-size: 27px; }
  .auth-footer { flex-wrap: wrap; line-height: 1.6; }
}
@media (prefers-reduced-motion: reduce) { .auth-spinner { animation: none; } .auth-submit { transition: none; } }
</style>
