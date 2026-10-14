<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useReleases } from '@/composables/useReleases'
import { SITE } from '@/config/site'
import type { Release, ReleaseAsset } from '@/types/release'

/**
 * 安装包页。
 *
 * 整页内容都从 `public/releases.json` 来 —— 加一个版本要做的只有两件事：
 *   ① 把安装包丢进 `public/downloads/`
 *   ② 往 releases.json 里加一条
 * 不用改这里的任何代码，甚至不用重新构建前端（把 JSON 覆盖到服务器上就行）。
 */

const { manifest, loading, load } = useReleases()

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

// ⚠️ 这段是要展示给维护者抄的示例，里面不能出现连续两个左花括号
//（那会被 Vue 当成插值，编译不过）。
const EXAMPLE = `{
  "latest": "0.1.0",
  "releases": [
    {
      "version": "0.1.0",
      "date": "2026-10-13",
      "title": "第一个公测版",
      "notes": "首版。\\n角色卡、世界书、状态面板、桌宠都能用。",
      "assets": [
        {
          "platform": "windows",
          "label": "Windows 安装包 (.exe)",
          "file": "/downloads/NocturneTavern-Setup-0.1.0.exe",
          "size": "78.2 MB",
          "sha256": "（可选，填了就会显示出来）"
        }
      ]
    }
  ]
}`
</script>

<template>
  <section class="sec">
    <div class="wrap">
      <div class="sec-head">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Download</span>
      </div>
      <h2>把窗口打开</h2>
      <p class="sec-sub">
        安装包和源码两条路，挑一条走。装好之后在<b class="hl">设置</b>里填一次模型接口，
        就可以开始了。
      </p>

      <!-- —————————————— 加载中 —————————————— -->
      <p v-if="loading" class="muted">正在读安装包清单…</p>

      <!-- —————————————— 还没有安装包 —————————————— -->
      <template v-else-if="!latest">
        <div class="empty">
          <div class="empty-mark" aria-hidden="true">
            <span class="lampblock" aria-hidden="true"></span>
          </div>
          <h3>安装包正在准备中</h3>
          <p>
            第一版还在打包。可以先<b>从源码跑起来</b>（见下方），
            或者等安装包放上来 —— 到时候这一页会自动换成下载列表。
          </p>
          <a class="btn btn-ghost" :href="SITE.repo" target="_blank" rel="noopener">
            去 GitHub 看源码<span class="arw">→</span>
          </a>
        </div>

        <!-- 给维护者看的：折叠起来，公开页面上不碍眼 -->
        <details class="admin-note">
          <summary>填清单的说明（站长看，可折叠）</summary>
          <p>
            把安装包放进 <code>public/downloads/</code>，然后往
            <code>public/releases.json</code> 里写一条 —— 上面的下载卡片就会自动出现。
            也可以把 <code>file</code> 直接写成外链（CDN / GitHub Release 都行）。
          </p>
          <pre>{{ EXAMPLE }}</pre>
        </details>
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
        <h3 class="source-title">不想等安装包，就从源码跑</h3>

        <div class="start">
          <div class="term">
            <div class="term-bar">
              <span class="lampblock lampblock--sm" aria-hidden="true"></span>
              <span>终端</span>
            </div>
            <div class="term-body">
              <div class="cmt"># 客户端代码都在 client/ 里，先进去</div>
              <div class="cmd">cd client</div>
              <div class="cmt"># 首次会下载约 100MB 的 Electron 运行时</div>
              <div class="cmd">npm install</div>
              <div class="cmd">npm start</div>
              <div class="out">Electron 已就绪 —— 窗口打开了</div>
            </div>
          </div>

          <ol class="steps">
            <li>
              <b>要有 Node.js 18+</b>
              Windows / macOS / Linux 都行。Windows 用户也可以直接双击
              <code>client\Start-Mimitale.cmd</code>，它会自己检查环境、自动装依赖。
            </li>
            <li>
              <b>填一次模型接口</b>
              启动后点左下角「设置」，从内置预设里挑一家填上 API Key。只填一次。
            </li>
            <li>
              <b>把角色卡拖进来</b>
              酒馆用的 PNG 卡直接导入，设定、头像、开场白、内嵌世界书一起到位。
            </li>
          </ol>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec { padding-top: var(--s8); }
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
  filter: drop-shadow(0 0 22px rgba(232, 184, 75, 0.35));
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

/* 站长说明：折叠着，公开页面上不占地方 */
.admin-note {
  margin-top: var(--s5);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: var(--s3) var(--s4);
}
.admin-note summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}
.admin-note p {
  font-size: 13.5px;
  color: var(--text-dim);
  line-height: 1.8;
  margin: var(--s4) 0;
}
.admin-note pre {
  margin: 0;
  padding: var(--s4);
  overflow-x: auto;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

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
.start {
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  gap: var(--s7);
}
.term {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-sunken);
  overflow: hidden;
}
.term-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 13px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-faint);
  letter-spacing: 0.06em;
}
.term-body {
  padding: var(--s4) var(--s5) var(--s5);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 2.1;
}
.term-body .cmt { color: var(--text-faint); }
.term-body .cmd { color: var(--text); }
.term-body .cmd::before { content: "$ "; color: var(--lamp); }
.term-body .out { color: var(--text-dim); margin-top: var(--s2); }

.steps { list-style: none; padding: 0; margin: 0; counter-reset: s; }
.steps li {
  position: relative;
  padding: 0 0 var(--s5) 40px;
  font-size: 15px;
  color: var(--text-dim);
  line-height: 1.75;
  counter-increment: s;
}
.steps li::before {
  content: counter(s, decimal-leading-zero);
  position: absolute;
  left: 0;
  top: 1px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--lamp);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  width: 26px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.steps li b { color: var(--text); font-weight: 600; display: block; margin-bottom: 2px; }
.steps li:last-child { padding-bottom: 0; }

@media (max-width: 860px) {
  .start { grid-template-columns: 1fr; gap: var(--s6); }
}
</style>
