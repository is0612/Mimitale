<script setup lang="ts">
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'
import { useRise } from './composables/useRise'

// 入场动效全站只装一次（.rise 那条规则需要同时看到一组兄弟，见 composable 里的说明）
useRise()
</script>

<template>
  <!-- 夜空 → 环境光 → 木吧台细纹：三层都是 fixed + z-index:0，按 DOM 顺序叠。
       夜空必须排在灯前面，否则星星会飘到光上面去。
       光只在「夜里」才成立 —— 这一层就是那个夜。 -->
  <div class="night" aria-hidden="true"></div>
  <div class="lamp" aria-hidden="true"></div>
  <div class="grain" aria-hidden="true"></div>

  <a class="skip-link" href="#top">跳到主要内容</a>
  <SiteHeader />

  <main id="top" tabindex="-1">
    <RouterView />
  </main>

  <SiteFooter />
</template>
