import { ref } from 'vue'

import type { Release, ReleaseAsset, ReleaseManifest } from '@/types/release'

const LOAD_TIMEOUT_MS = 10_000
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'other'])

function emptyManifest(): ReleaseManifest {
  return { latest: '', releases: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** Resolve download links before rendering; never pass an unchecked href to Vue. */
function downloadHref(value: string): string {
  const file = value.trim()
  if (!file) return ''
  if (/[\u0000-\u0020\u007f\\]/.test(file)) throw new Error('Invalid download URL')

  const siteBase = new URL(import.meta.env.BASE_URL, window.location.origin)
  const url = new URL(file, siteBase)
  if (/^https?:\/\//i.test(file)) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid download URL')
    }
    return url.href
  }

  const downloadsPath = new URL('downloads/', siteBase).pathname
  if (
    url.origin !== window.location.origin ||
    !(file.startsWith('/downloads/') || file.startsWith('downloads/') || file.startsWith(downloadsPath))
  ) {
    throw new Error('Invalid download path')
  }
  const path = decodeURIComponent(url.pathname)
  if (
    !(path.startsWith('/downloads/') || path.startsWith(downloadsPath)) ||
    /[\u0000-\u001f\u007f\\]/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    /%(?:2e|2f|5c)/i.test(path)
  ) {
    throw new Error('Invalid download path')
  }
  return url.href
}

function parseAsset(value: unknown): ReleaseAsset {
  if (
    !isRecord(value) ||
    typeof value.platform !== 'string' || !PLATFORMS.has(value.platform) ||
    !requiredText(value.label) || typeof value.file !== 'string' ||
    !optionalText(value.size) || !optionalText(value.sha256) ||
    (typeof value.sha256 === 'string' && value.sha256 !== '' && !/^[a-f0-9]{64}$/i.test(value.sha256))
  ) {
    throw new Error('Invalid release asset')
  }
  return {
    platform: value.platform as ReleaseAsset['platform'],
    label: value.label,
    file: downloadHref(value.file),
    ...(value.size !== undefined ? { size: value.size as string } : {}),
    ...(value.sha256 !== undefined ? { sha256: value.sha256 as string } : {})
  }
}

function parseRelease(value: unknown): Release {
  if (
    !isRecord(value) || !requiredText(value.version) ||
    typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    !Number.isFinite(Date.parse(value.date)) ||
    new Date(value.date).toISOString().slice(0, 10) !== value.date ||
    !optionalText(value.title) || !optionalText(value.notes) || !Array.isArray(value.assets)
  ) {
    throw new Error('Invalid release')
  }
  return {
    version: value.version,
    date: value.date,
    assets: value.assets.map(parseAsset),
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.notes !== undefined ? { notes: value.notes as string } : {})
  }
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || typeof value.latest !== 'string' || !Array.isArray(value.releases)) {
    throw new Error('Invalid release manifest')
  }
  const releases = value.releases.map(parseRelease)
  const versions = new Set(releases.map((release) => release.version))
  if (versions.size !== releases.length || (value.latest !== '' && !versions.has(value.latest))) {
    throw new Error('Invalid latest release')
  }
  return { latest: value.latest, releases }
}

/** Fetch the runtime manifest so release downloads can be updated independently. */
export function useReleases() {
  const manifest = ref<ReleaseManifest>(emptyManifest())
  const loading = ref(true)
  const failed = ref(false)
  let inFlight = false

  async function load(): Promise<void> {
    if (inFlight) return
    inFlight = true
    loading.value = true
    failed.value = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Release request timed out'))
        }, LOAD_TIMEOUT_MS)
      })
      const request = async () => {
        const res = await fetch(`${import.meta.env.BASE_URL}releases.json`, {
          cache: 'no-cache',
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return parseManifest(await res.json())
      }
      manifest.value = await Promise.race([request(), timeout])
    } catch {
      failed.value = true
      manifest.value = emptyManifest()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      loading.value = false
      inFlight = false
    }
  }

  return { manifest, loading, failed, load }
}
