<script setup lang="ts">
import { BRAND_LOGO } from '@/config/brand'
import { SITE } from '@/config/site'

/**
 * 品牌标识 = 圆形徽标 + 字标。
 *
 * 徽标用真的 logo（那瓶星空高脚杯）：原图是 1:1 方图，圆形裁掉四角，
 * 深色底上圆边无缝，比方形边界干净得多。
 * 字标走 CSS 文字（衬线中文 + 等宽英文）—— 是矢量的，缩到 16px 也清楚。
 */
withDefaults(defineProps<{ size?: 'md' | 'sm' }>(), { size: 'md' })
</script>

<template>
  <RouterLink
    class="brand"
    :class="`brand--${size}`"
    to="/"
    :aria-label="`${SITE.name} 首页`"
  >
    <span class="emblem">
      <img :src="BRAND_LOGO" alt="" width="30" height="30">
    </span>
    <span class="name">{{ SITE.name }}</span>
    <span class="latin">{{ SITE.latin }}</span>
  </RouterLink>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.emblem {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  overflow: hidden;
  flex: none;
  background: var(--bg);
  /* 1px 环 + 一点冷光：logo 本身是深蓝星空，落在深灰底上要靠这圈线立住 */
  box-shadow:
    0 0 0 1px var(--border-hi),
    0 0 16px color-mix(in srgb, var(--cool) 16%, transparent);
}
.emblem img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.name {
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1;
  white-space: nowrap;
}
.latin {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--text-faint);
  text-transform: uppercase;
  padding-left: 11px;
  border-left: 1px solid var(--border);
  line-height: 1;
  white-space: nowrap;
}

.brand--sm .emblem { width: 26px; height: 26px; }
.brand--sm .name { font-size: 17px; }

/* 窄屏保字标优先：英文并排会把它挤到换行，索性收掉 */
@media (max-width: 620px) {
  .latin { display: none; }
}
</style>
