<script setup lang="ts">
/**
 * 图片区 —— 占位，还没做。
 *
 * 这一页刻意做得很小：它存在的意义只是把「位置」和「数据形状」先钉下来。
 * 等真要放图时，要做的两件事：
 *   ① 往 `public/photos.json` 里写图（<img> 的 src 只是个字符串，站内相对路径也行、
 *      外链 CDN 也行，跟 installers 一个路子）
 *   ② 需要访客自己上传时，再谈后端 —— 那必须配一个能存文件的云服务
 *      （对象存储 + 一个上传接口），本地静态站做不到这件事
 * 顺手把 `/gallery` 挂进 router 的 routes 里（已经在），要放进导航再往
 * components/SiteHeader.vue 的 nav 里加一条即可。
 */
import { SITE } from '@/config/site'
</script>

<template>
  <section class="sec">
    <div class="wrap">
      <div class="sec-head">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Gallery</span>
      </div>
      <h2>图片区</h2>
      <p class="sec-sub">
        这块还没开。位置先留着 —— 以后放角色立绘、酒馆截图、大家的作品。
      </p>

      <div class="placeholder">
        <p>
          真要开的时候：站内图片直接把地址写进 <code>public/photos.json</code> 就能显示；
          但<b>让访客自己上传</b>需要后端（对象存储 + 上传接口），
          本地静态站做不到 —— 到那一步再单独决定。
        </p>
        <a class="btn btn-ghost" :href="SITE.repo" target="_blank" rel="noopener">
          先去 GitHub 看看<span class="arw">→</span>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec { padding-top: var(--s8); }
.placeholder {
  border: 1px dashed var(--border-hi);
  border-radius: var(--radius);
  padding: var(--s6);
  max-width: 620px;
}
.placeholder p {
  margin: 0 0 var(--s5);
  font-size: 14.5px;
  line-height: 1.9;
  color: var(--text-dim);
}
.placeholder p b { color: var(--text); font-weight: 600; }
</style>
