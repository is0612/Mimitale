import { ref } from 'vue'

import type { ReleaseManifest } from '@/types/release'

function emptyManifest(): ReleaseManifest {
  return { latest: '', releases: [] }
}

/**
 * 读 `public/releases.json`。
 *
 * 刻意走运行时 fetch，而不是 `import` 进来：这样换版本时往服务器上
 * 覆盖一个 JSON、丢一个安装包就完事，**不用重新构建前端**。
 */
export function useReleases() {
  const manifest = ref<ReleaseManifest>(emptyManifest())
  const loading = ref(true)
  const failed = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    failed.value = false
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}releases.json`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      manifest.value = (await res.json()) as ReleaseManifest
    } catch {
      // 清单还没放上去、或者格式坏了：当作「暂时没有安装包」，不要把页面搞崩
      failed.value = true
      manifest.value = emptyManifest()
    } finally {
      loading.value = false
    }
  }

  return { manifest, loading, failed, load }
}
