<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import BrandMark from './BrandMark.vue'
import { HOME_SECTIONS } from '@/config/site'

const route = useRoute()
const pinned = ref(false)
const menuOpen = ref(false)
function onScroll(): void { pinned.value = window.scrollY > 12 }
function closeMenu(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menuOpen.value) {
    menuOpen.value = false
    document.getElementById('menu-toggle')?.focus()
  }
}
watch(() => route.fullPath, () => { menuOpen.value = false })
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', closeMenu)
  onScroll()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', closeMenu)
})
</script>

<template>
  <header class="topbar" :class="{ 'is-pinned': pinned }">
    <div class="wrap">
      <BrandMark />
      <button id="menu-toggle" class="btn btn-ghost btn-sm menu-toggle" type="button" :aria-expanded="menuOpen" aria-controls="site-nav" @click="menuOpen = !menuOpen">{{ menuOpen ? '收起' : '菜单' }}</button>
      <nav id="site-nav" class="nav" :class="{ 'is-open': menuOpen }" aria-label="主导航">
        <RouterLink v-for="section in HOME_SECTIONS" :key="section.id" :to="{ path: '/', hash: `#${section.id}` }" :class="{ current: route.path === '/' && route.hash === `#${section.id}` }" :aria-current="route.path === '/' && route.hash === `#${section.id}` ? 'location' : undefined" @click="menuOpen = false">{{ section.label }}</RouterLink>
      </nav>
      <RouterLink class="btn btn-primary btn-sm download-link" to="/download">开始使用<span class="arw">→</span></RouterLink>
    </div>
  </header>
</template>

<style scoped>
.topbar { position: sticky; top: 0; z-index: 20; backdrop-filter: blur(14px); background: color-mix(in srgb, var(--bg) 66%, transparent); border-bottom: 1px solid transparent; transition: background 0.3s var(--ease), border-color 0.3s var(--ease); }
.topbar.is-pinned { background: color-mix(in srgb, var(--bg) 90%, transparent); border-bottom-color: var(--border); }
.topbar .wrap { display: flex; align-items: center; gap: var(--s4); height: var(--topbar-h); }
.nav { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.nav a { font-size: 14px; color: var(--text-dim); padding: 7px 10px; border-radius: var(--radius-sm); transition: color 0.18s var(--ease), background 0.18s var(--ease); }
.nav a:hover, .nav a.current { color: var(--text); background: var(--bg-item); }
.menu-toggle { display: none; }
@media (max-width: 1060px) {
  .menu-toggle { display: inline-flex; margin-left: auto; }
  .nav { display: none; position: absolute; top: var(--topbar-h); left: 0; right: 0; padding: var(--s4) var(--gut); background: var(--bg-side); border-bottom: 1px solid var(--border-hi); box-shadow: 0 12px 24px #0006; }
  .nav.is-open { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); }
  .nav a { padding: 10px; }
}
@media (max-width: 480px) {
  .topbar .wrap { gap: var(--s2); }
  .download-link { padding: 8px 10px; }
  .download-link .arw { display: none; }
}
</style>
