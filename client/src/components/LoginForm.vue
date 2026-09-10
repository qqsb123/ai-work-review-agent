<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

const username = ref('')
const password = ref('')
const loading = ref(false)
const isRegister = ref(false)

const emit = defineEmits<{
  success: []
}>()

async function submit() {
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请输入用户名和密码')
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

    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

function toggleMode() {
  isRegister.value = !isRegister.value
  username.value = ''
  password.value = ''
}
</script>

<template>
  <section class="card">
    <h2 class="card-title">
      {{ isRegister ? '注册' : '登录' }}
    </h2>

    <div class="form-item">
      <label>用户名</label>
      <el-input
        v-model="username"
        placeholder="请输入用户名"
      />
    </div>

    <div class="form-item">
      <label>密码</label>
      <el-input
        v-model="password"
        type="password"
        show-password
        placeholder="请输入密码"
      />
    </div>

    <div class="actions">
      <el-button
        type="primary"
        :loading="loading"
        @click="submit"
      >
        {{ isRegister ? '注册' : '登录' }}
      </el-button>
    </div>

    <div style="margin-top: 12px; text-align: center;">
      <el-button
        link
        type="primary"
        @click="toggleMode"
      >
        {{
          isRegister
            ? '已有账号？去登录'
            : '没有账号？去注册'
        }}
      </el-button>
    </div>
  </section>
</template>