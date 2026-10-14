import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '@/views/HomeView.vue'

export const router = createRouter({
  // ⚠️ history 模式：部署到 nginx 时，站点根要配 `try_files $uri $uri/ /index.html;`
  //    （否则直接访问 /download 会 404）。嫌麻烦就换成 createWebHashHistory()。
  history: createWebHistory(import.meta.env.BASE_URL),

  routes: [
    { path: '/', name: 'home', component: HomeView },

    // 安装包清单页 —— 内容全部来自 public/releases.json，加版本不用改代码。
    {
      path: '/download',
      name: 'download',
      component: () => import('@/views/DownloadView.vue')
    },

    // 图片区的占位。还没做，也不在任何导航里 —— 先把位置和数据结构留下来，
    // 等真要放图和上传时，只补这一个页面 + public/photos.json 就行。
    {
      path: '/gallery',
      name: 'gallery',
      component: () => import('@/views/GalleryView.vue')
    },

    // 其余一律回首页（不单独做 404 页 —— 这种官网没必要）
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],

  scrollBehavior(to, _from, saved) {
    if (saved) return saved
    if (to.hash) {
      // top 是相对目标元素的偏移：顶栏贴着顶，不避开就会被盖住。
      // 与 base.css 的 scroll-margin-top 同口径（--topbar-h 62 + 14 余量）。
      return { el: to.hash, top: 76, behavior: 'smooth' }
    }
    return { top: 0 }
  }
})
