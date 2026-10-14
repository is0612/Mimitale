<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useReleases } from '@/composables/useReleases'
import { SITE } from '@/config/site'
import type { Release, ReleaseAsset } from '@/types/release'

const { manifest, loading, failed, load } = useReleases()

onMounted(() => {
  void load()
})

/** 最新版：以 manifest.latest 为准；它没填或对不上，就取第一条 */
const latest = computed<Release | null>(() => {
  const list = manifest.value.releases
  if (list.length === 0) return null
  return list.find((r) => r.version === manifest.value.latest) ?? list[0]
})

/** 更早的版本 */
const older = computed<Release[]>(() => {
  const top = latest.value
  if (!top) return []
  return manifest.value.releases.filter((r) => r !== top)
})

const PLATFORM_LABEL: Record<ReleaseAsset['platform'], string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  other: '其他'
}

/** 清单里 file 还空着的条目 = 文件没传，按钮置灰（别给一个点了 404 的按钮） */
function ready(asset: ReleaseAsset): boolean {
  return asset.file.trim().length > 0
}

</script>

<template>
  <section class="sec page">
    <div class="wrap">
      <div class="sec-head">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Download</span>
      </div>
      <h1 class="page-title">把窗口打开</h1>
      <p class="sec-sub">
        选择安装包，或从源码启动。默认通过模型 API 对话，无需高性能显卡；
        启动后在<b class="hl">设置</b>里配置服务商与 API Key。
        模型调用可能产生费用，由服务商按其规则收费。
      </p>

      <!-- —————————————— 加载中 —————————————— -->
      <p v-if="loading" class="muted" role="status" aria-live="polite">正在读取安装包清单…</p>

      <!-- —————————————— 清单读取失败 —————————————— -->
      <div v-else-if="failed" class="empty">
        <h3>暂时无法读取下载列表</h3>
        <p role="alert">可能是网络连接或下载服务暂时不可用。请重试，也可以先按下方步骤从源码启动。</p>
        <button class="btn btn-ghost" type="button" @click="load">重新加载<span class="arw">↻</span></button>
      </div>

      <!-- —————————————— 还没有安装包 —————————————— -->
      <template v-else-if="!latest">
        <div class="empty">
          <div class="empty-mark" aria-hidden="true">
            <span class="lampblock" aria-hidden="true"></span>
          </div>
          <h3>安装包正在准备中</h3>
          <p>
            当前还没有可下载的安装包。可以先按下方步骤<b>从源码启动</b>，
            或稍后回来查看发布情况。
          </p>
          <a class="btn btn-ghost" :href="SITE.repo" target="_blank" rel="noopener">
            去 GitHub 看源码<span class="arw">→</span>
          </a>
        </div>

      </template>

      <!-- —————————————— 有安装包 —————————————— -->
      <template v-else>
        <div class="ver-head">
          <span class="ver-badge">最新</span>
          <span class="ver-no">v{{ latest.version }}</span>
          <span class="ver-date">{{ latest.date }}</span>
          <span v-if="latest.title" class="ver-title">{{ latest.title }}</span>
        </div>

        <div class="assets">
          <div v-for="asset in latest.assets" :key="asset.label" class="asset">
            <div class="asset-top">
              <span class="plat">{{ PLATFORM_LABEL[asset.platform] }}</span>
              <span v-if="asset.size" class="size">{{ asset.size }}</span>
            </div>
            <div class="asset-label">{{ asset.label }}</div>

            <a
              v-if="ready(asset)"
              class="btn btn-primary asset-btn"
              :href="asset.file"
              download
            >
              下载<span class="arw">→</span>
            </a>
            <span v-else class="btn btn-ghost asset-btn is-off">文件待补</span>

            <div v-if="asset.sha256" class="sha">sha256 {{ asset.sha256 }}</div>
          </div>
        </div>

        <ul v-if="latest.notes" class="notes">
          <li v-for="(line, i) in latest.notes.split('\n')" :key="i">{{ line }}</li>
        </ul>

        <div v-if="older.length" class="older">
          <h3>更早的版本</h3>
          <div v-for="release in older" :key="release.version" class="old-row">
            <span class="old-no">v{{ release.version }}</span>
            <span class="old-date">{{ release.date }}</span>
            <span class="old-links">
              <a
                v-for="asset in release.assets.filter(ready)"
                :key="asset.label"
                :href="asset.file"
                download
              >{{ PLATFORM_LABEL[asset.platform] }}</a>
            </span>
          </div>
        </div>
      </template>

      <!-- —————————————— 源码运行（一直可用） —————————————— -->
      <div class="source">
        <div class="sec-head">
          <span class="lampblock lampblock--sm" aria-hidden="true"></span>
          <span class="sec-kicker">From source</span>
        </div>
        <h3 class="source-title">从源码启动</h3>
        <p class="source-intro">
          这条路线需要 Node.js 18+；使用安装包无需另装 Node.js。
          先<a :href="SITE.repo" target="_blank" rel="noopener">获取 GitHub 仓库</a>：
          可以用下面的 Git 命令，或在仓库页选择 Code → Download ZIP，解压后在所得文件夹中打开终端，
          执行 <code>cd client</code>、<code>npm install</code>、<code>npm start</code>。
        </p>

        <div class="start">
          <div class="term">
            <div class="term-bar">
              <span class="lampblock lampblock--sm" aria-hidden="true"></span>
              <span>终端</span>
            </div>
            <div class="term-body">
              <div class="cmt"># 先用 Git 获取仓库（需要已安装 Git）</div>
              <div class="cmd">git clone {{ SITE.repo }}.git Mimitale</div>
              <div class="cmd">cd Mimitale/client</div>
              <div class="cmt"># 首次安装会下载依赖和 Electron 运行时</div>
              <div class="cmd">npm install</div>
              <div class="cmd">npm start</div>
            </div>
          </div>

          <ol class="steps">
            <li>
              <b>源码启动需 Node.js 18+</b>
              Windows / macOS / Linux 均可。选择预构建安装包则无需单独安装 Node.js。
            </li>
            <li>
              <b>配置服务商和 API Key</b>
              在左下角「设置」中选择模型服务商并填写该服务商签发的 API Key。
              是否收费、价格和计费方式由服务商决定；请先查看其当前定价，密钥不要分享给他人。
            </li>
            <li>
              <b>在角色库导入角色卡</b>
              打开「角色库」，点击「导入角色」按钮选择 PNG 角色卡，再选择角色开始对话。
            </li>
          </ol>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-title {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: clamp(28px, 3.6vw, 40px);
  line-height: 1.25;
  letter-spacing: 0.01em;
  margin: 0 0 var(--s4);
  text-wrap: balance;
}
.source-intro {
  color: var(--text-dim);
  font-size: 14.5px;
  line-height: 1.85;
  margin: 0 0 var(--s5);
}
.source-intro a { color: var(--lamp); text-decoration: underline; text-underline-offset: 3px; }
.term .cmd { overflow-wrap: anywhere; }
.hl { color: var(--text); font-weight: 600; }
.muted { color: var(--text-faint); font-size: 14px; }

/* ------------------------------ 空态 ------------------------------ */
.empty {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-side);
  padding: var(--s7) var(--s6);
  text-align: center;
}
.empty-mark {
  display: flex;
  justify-content: center;
  margin-bottom: var(--s5);
  /* 让那块琥珀「亮」一点，把空态撑起来 */
  filter: drop-shadow(0 0 22px var(--lamp-a35));
}
.empty h3 {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 var(--s3);
}
.empty p {
  font-size: 15px;
  color: var(--text-dim);
  line-height: 1.85;
  max-width: 480px;
  margin: 0 auto var(--s5);
}
.empty p b { color: var(--text); font-weight: 600; }

/* ------------------------------ 版本头 ------------------------------ */
.ver-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s3);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--border);
}
.ver-badge {
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  color: var(--on-lamp);
  background: var(--lamp);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
}
.ver-no {
  font-family: var(--font-mono);
  font-size: 18px;
  color: var(--text);
}
.ver-date {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text-faint);
}
.ver-title {
  font-size: 14.5px;
  color: var(--text-dim);
}

/* ------------------------------ 文件卡片 ------------------------------ */
.assets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: var(--s4);
  margin-top: var(--s5);
}
.asset {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-side);
  padding: var(--s5);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  transition: border-color 0.2s var(--ease);
}
.asset:hover { border-color: var(--border-hi); }
.asset-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s2);
}
.plat {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--lamp);
  letter-spacing: 0.04em;
}
.size {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-faint);
}
.asset-label {
  font-size: 14px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: var(--s2);
}
.asset-btn { width: 100%; }
.asset-btn.is-off {
  cursor: default;
  color: var(--text-faint);
  border-color: var(--border);
}
.asset-btn.is-off:hover { border-color: var(--border); color: var(--text-faint); }
.sha {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  word-break: break-all;
  line-height: 1.6;
}

/* ------------------------------ 更新说明 ------------------------------ */
.notes {
  margin: var(--s5) 0 0;
  padding-left: var(--s5);
  color: var(--text-dim);
  font-size: 14.5px;
  line-height: 1.9;
}

/* ------------------------------ 更早的版本 ------------------------------ */
.older { margin-top: var(--s6); }
.older h3 {
  font-size: 13px;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 0 0 var(--s3);
  font-weight: 500;
}
.old-row {
  display: flex;
  align-items: baseline;
  gap: var(--s4);
  padding: var(--s3) 0;
  font-size: 14px;
  border-top: 1px solid var(--border);
}
.old-no { font-family: var(--font-mono); color: var(--text); min-width: 72px; }
.old-date { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-faint); }
.old-links { display: flex; gap: var(--s4); margin-left: auto; }
.old-links a {
  color: var(--text-dim);
  transition: color 0.18s var(--ease);
}
.old-links a:hover { color: var(--lamp); }

/* ------------------------------ 源码运行 ------------------------------ */
.source { margin-top: var(--s8); padding-top: var(--s6); border-top: 1px solid var(--border); }
.source-title {
  font-family: var(--font-serif);
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 var(--s5);
}
/* 终端框 + 步骤表的样式在 base.css（与首页共用一份） */

@media (max-width: 860px) {
  .start { grid-template-columns: 1fr; gap: var(--s6); }
}
</style>
