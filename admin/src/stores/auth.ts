/**
 * 登录态 —— 注意这里存的是**管理员**，不是客户。
 * 客户是你要管理的数据，不是登录本后台的人。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as adminApi from '@/api/admin'
import { clearAuthTokens, onAuthTokenChange, setAuthTokens, TOKEN_KEY } from '@/api/request'
import type { AdminAccount } from '@/types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
  const admin = ref<AdminAccount | null>(null)
  const loading = ref(false)
  let storeGeneration = 0

  const isLoggedIn = computed(() => Boolean(token.value))
  const displayName = computed(() => admin.value?.nickname || admin.value?.username || '未登录')

  onAuthTokenChange((nextToken) => {
    token.value = nextToken
    if (!nextToken) {
      storeGeneration += 1
      admin.value = null
    }
  })

  function persist(nextToken: string, refreshToken?: string): void {
    setAuthTokens(nextToken, refreshToken)
  }

  /** 登录。没有注册分支 —— 账号密码不对就是不对 */
  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      const generation = storeGeneration
      const res = await adminApi.adminLogin({ username, password })
      if (generation !== storeGeneration) return
      persist(res.token, res.refreshToken)
      admin.value = res.admin
    } finally {
      loading.value = false
    }
  }

  /** 拿当前管理员；token 失效时 request 层会自动跳登录页 */
  async function loadMe(): Promise<AdminAccount | null> {
    if (!token.value) return null
    const generation = storeGeneration
    const me = await adminApi.adminMe()
    if (generation !== storeGeneration) return null
    admin.value = me
    return me
  }

  function logout(): void {
    // JWT is stateless server-side; clear immediately so pending responses cannot restore it.
    storeGeneration += 1
    admin.value = null
    clearAuthTokens()
  }

  return { token, admin, loading, isLoggedIn, displayName, login, loadMe, logout }
})
