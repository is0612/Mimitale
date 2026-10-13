<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import BrandMark from './BrandMark.vue'
import { HOME_SECTIONS } from '@/config/site'

/** 滚过一屏后压深底色 + 出底边线，让顶栏从「浮在内容上」变成「压在内容上」。 */
const pinned = ref(false)

function onScroll(): void {
  pinned.value = window.scrollY > 12
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <header class="topbar" :class="{ 'is-pinned': pinned }">
    <div class="wrap">
      <BrandMark />

      <nav class="nav" aria-label="主导航">
        <RouterLink
          v-for="section in HOME_SECTIONS"
          :key="section.id"
          :to="{ path: '/', hash: `#${section.id}` }"
        >
          {{ section.label }}
        </RouterLink>
        <RouterLink to="/download">下载</RouterLink>
      </nav>

      <RouterLink class="btn btn-primary btn-sm" to="/download">
        下载安装包<span class="arw">→</span>
      </RouterLink>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(14px);
  background: rgba(16, 17, 19, 0.66);
  border-bottom: 1px solid transparent;
  transition: background 0.3s var(--ease), border-color 0.3s var(--ease);
}
.topbar.is-pinned {
  background: rgba(16, 17, 19, 0.9);
  border-bottom-color: var(--border);
}
.topbar .wrap {
  display: flex;
  align-items: center;
  gap: var(--s5);
  height: var(--topbar-h);
}

.nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.nav a {
  font-size: 14px;
  color: var(--text-dim);
  padding: 7px 11px;
  border-radius: var(--radius-sm);
  transition: color 0.18s var(--ease), background 0.18s var(--ease);
}
.nav a:hover { color: var(--text); background: var(--bg-item); }
/* 当前所在的页签（/download 那条）常亮。
   ⚠️ 用 exact 而不是 router-link-active：首页那几条锚点链接的 path 也是 `/`，
   用非 exact 的话，在首页上它们会**一起**亮起来。 */
.nav a.router-link-exact-active { color: var(--text); background: var(--bg-item); }

@media (max-width: 900px) {
  .nav { display: none; }
}
</style>
