<script setup lang="ts">
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'
import { useRise } from './composables/useRise'

// 入场动效全站只装一次（.rise 那条规则需要同时看到一组兄弟，见 composable 里的说明）
useRise()
</script>

<template>
  <!-- 环境光 + 木吧台细纹：整页唯一的大面积「光」，其余亮部都从它派生 -->
  <div class="lamp" aria-hidden="true"></div>
  <div class="grain" aria-hidden="true"></div>

  <SiteHeader />

  <main id="top">
    <RouterView />
  </main>

  <SiteFooter />
</template>
