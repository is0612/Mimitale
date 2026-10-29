/** Axios response envelope and administrator authentication. */
import axios, { type AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import { ApiCode, type ApiResult } from '@/types'
import { mockAdapter } from '@/mock'

/** Development retains the explicit mock switch; production builds must set it to false. */
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'
export const TOKEN_KEY = 'mimitale_admin_token'
export const REFRESH_TOKEN_KEY = 'mimitale_admin_refresh'

export class ApiError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

type AuthConfig = InternalAxiosRequestConfig & { _authRetried?: boolean; _authGeneration?: number; _accessToken?: string }
let authGeneration = 0
const tokenListeners = new Set<(token: string) => void>()
export function onAuthTokenChange(listener: (token: string) => void): () => void {
  tokenListeners.add(listener)
  return () => { tokenListeners.delete(listener) }
}
function notifyToken(token: string): void { for (const listener of tokenListeners) listener(token) }
export function invalidatePendingAuth(): void { authGeneration += 1 }
export function setAuthTokens(token: string, refreshToken?: string): void {
  invalidatePendingAuth()
  localStorage.setItem(TOKEN_KEY, token)
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
  notifyToken(token)
}
export function clearAuthTokens(): void {
  invalidatePendingAuth()
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  notifyToken('')
}

const options = { baseURL: import.meta.env.VITE_API_BASE || '/api', timeout: 15_000 }
const http = axios.create(options)
// A separate instance avoids recursively intercepting a failed refresh request.
const refreshHttp = axios.create(options)
if (USE_MOCK) { http.defaults.adapter = mockAdapter; refreshHttp.defaults.adapter = mockAdapter }

http.interceptors.request.use((config: AuthConfig) => {
  const token = localStorage.getItem(TOKEN_KEY) || ''
  config._authGeneration = authGeneration
  config._accessToken = token
  if (token) config.headers.Authorization = `Bearer ${token}`
  else config.headers.delete('Authorization')
  return config
})

function backToLogin(message: string): void {
  clearAuthTokens()
  ElMessage.warning(message)
  if (!window.location.hash.startsWith('#/login')) {
    window.location.hash = '#/login'
    window.location.reload()
  }
}

let refreshing: { generation: number; refreshToken: string; promise: Promise<string | null> } | null = null
function refreshAccessToken(refreshToken: string, generation: number): Promise<string | null> {
  if (refreshing?.generation === generation && refreshing.refreshToken === refreshToken) return refreshing.promise
  const promise = (async () => {
    const response = await refreshHttp.post<ApiResult<{ token: string }>>('/admin/auth/refresh', { refreshToken })
    const body = response.data
    if (body.code !== ApiCode.OK || !body.data?.token) throw new ApiError(body.code, body.message || '登录刷新失败')
    // A response belonging to an old login must not restore logout or overwrite another account.
    if (authGeneration !== generation || localStorage.getItem(REFRESH_TOKEN_KEY) !== refreshToken) return null
    localStorage.setItem(TOKEN_KEY, body.data.token)
    notifyToken(body.data.token)
    return body.data.token
  })()
  const active = { generation, refreshToken, promise }
  refreshing = active
  promise.then(() => { if (refreshing === active) refreshing = null }, () => { if (refreshing === active) refreshing = null })
  return promise
}

http.interceptors.response.use(response => response, async (error: AxiosError<ApiResult<unknown>>) => {
  const status = error.response?.status
  const body = error.response?.data
  const config = error.config as AuthConfig | undefined
  if (status !== 401) {
    if (!body) ElMessage.error(USE_MOCK ? 'mock 出错了，看下控制台' : '连不上后端，确认服务启动了吗')
    return Promise.reject(error)
  }
  const isLogin = /\/admin\/auth\/login(?:\?|$)/.test(config?.url || '')
  if (isLogin) {
    ElMessage.error(body?.message || '账号或密码不对')
    return Promise.reject(error)
  }
  if (!config || config._authGeneration !== authGeneration) return Promise.reject(error)
  const latestToken = localStorage.getItem(TOKEN_KEY) || ''
  if (config._accessToken !== latestToken && latestToken && !config._authRetried) {
    config._authRetried = true
    config.headers.Authorization = `Bearer ${latestToken}`
    return http.request(config)
  }
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  if (!config._authRetried && refreshToken) {
    let token: string | null
    try {
      token = await refreshAccessToken(refreshToken, authGeneration)
    } catch (refreshError) {
      // Only an explicit rejection invalidates credentials. Offline/5xx retain them for retry.
      const refreshStatus = (refreshError as AxiosError).response?.status
      if (refreshStatus === 401 && config._authGeneration === authGeneration) backToLogin('登录已过期，请重新登录')
      else if (refreshStatus !== 401) ElMessage.error('登录刷新暂时失败，请稍后重试')
      return Promise.reject(refreshError)
    }
    if (!token || config._authGeneration !== authGeneration) return Promise.reject(error)
    config._authRetried = true
    // Keep the retried request outside the refresh catch: its network/5xx is not refresh failure.
    return http.request(config)
  }
  backToLogin(body?.message || '登录已过期，请重新登录')
  return Promise.reject(error)
})

export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await http.request<ApiResult<T>>(config)
    const body = response.data
    if (body.code !== ApiCode.OK) {
      ElMessage.error(body.message || '请求失败')
      throw new ApiError(body.code, body.message)
    }
    return body.data
  } catch (error) {
    if (error instanceof ApiError) throw error
    const body = (error as AxiosError<ApiResult<unknown>>)?.response?.data
    throw new ApiError(body?.code ?? ApiCode.SERVER_ERROR, body?.message ?? '请求失败')
  }
}
