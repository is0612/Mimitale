<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import { DOC_LINKS, SITE } from '@/config/site'

/** 页脚分三列：开始 / 深入 / 文档。前两列是首页锚点，最后一列是外链。 */
const START_LINKS = [
  { label: '快速开始', to: { path: '/', hash: '#start' } },
  { label: '功能介绍', to: { path: '/', hash: '#pieces' } },
  { label: '下载安装', to: '/download' },
  { label: '数据与隐私', to: { path: '/', hash: '#privacy' } }
]

const DEEP_LINKS = [
  { label: '长对话记忆', to: { path: '/', hash: '#memory' } },
  { label: '模型接入', to: { path: '/', hash: '#models' } },
  { label: '桌宠', to: { path: '/', hash: '#pet' } }
]
</script>

<template>
  <footer>
    <div class="wrap">
      <div class="foot-grid">
        <div class="foot-brand">
          <BrandMark size="sm" class="foot-logo" />
          <p>
            一个跑在自己电脑上的桌面对话 AI。<br>
            角色扮演、世界书、状态面板 —— 都在本地。
          </p>
        </div>

        <div class="foot-cols">
          <div class="foot-col">
            <h4>开始</h4>
            <RouterLink v-for="link in START_LINKS" :key="link.label" :to="link.to">
              {{ link.label }}
            </RouterLink>
          </div>

          <div class="foot-col">
            <h4>深入</h4>
            <RouterLink v-for="link in DEEP_LINKS" :key="link.label" :to="link.to">
              {{ link.label }}
            </RouterLink>
          </div>

          <div class="foot-col">
            <h4>文档</h4>
            <a
              v-for="link in DOC_LINKS"
              :key="link.label"
              :href="link.href"
              target="_blank"
              rel="noopener"
            >
              {{ link.label }}
            </a>
          </div>
        </div>
      </div>

      <div class="foot-bottom">
        <span>{{ SITE.license }} License · {{ SITE.name }} {{ SITE.latin }}</span>
        <span>本地保存 · 自选模型 · API 直连</span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
footer {
  margin-top: var(--s9);
  border-top: 1px solid var(--border);
  padding: var(--s7) 0 var(--s6);
  position: relative;
  z-index: 1;
}
.foot-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s7);
  justify-content: space-between;
  align-items: flex-start;
}
.foot-brand { max-width: 320px; }
.foot-logo { margin-bottom: var(--s3); }
.foot-brand p { font-size: 13.5px; color: var(--text-faint); margin: 0; line-height: 1.8; }

.foot-cols { display: flex; gap: var(--s8); flex-wrap: wrap; }
.foot-col h4 {
  font-size: 12px;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 0 0 var(--s3);
  font-weight: 500;
}
.foot-col a {
  display: block;
  font-size: 14px;
  color: var(--text-dim);
  padding: 4px 0;
  transition: color 0.18s var(--ease);
}
.foot-col a:hover { color: var(--lamp); }

.foot-bottom {
  margin-top: var(--s7);
  padding-top: var(--s4);
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  gap: var(--s4);
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  letter-spacing: 0.03em;
}

@media (max-width: 620px) {
  .foot-cols { gap: var(--s6); }
}
</style>
