import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 入场动效（.rise）全站只装一次 —— 在 App.vue 里调用。
 *
 * 为什么不用自定义指令逐个元素挂：官网里 .rise 有几十处，
 * 逐处加指令是噪音；而且「同一父容器里的兄弟依次延迟」这条规则
 * 本来就需要同时看到一组兄弟元素，交给一个观察者统一算更顺。
 */
export function useRise(): void {
  let observer: IntersectionObserver | null = null

  function ensureObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === 'undefined') return null
    if (observer) return observer

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement

          const siblings = Array.from(el.parentElement?.children ?? []).filter(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && node.classList.contains('rise')
          )
          el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 3) * 90}ms`
          el.classList.add('in')
          observer?.unobserve(el)
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    )
    return observer
  }

  function scan(): void {
    const items = document.querySelectorAll<HTMLElement>('.rise:not(.in)')
    if (items.length === 0) return

    const io = ensureObserver()
    // 没有 IntersectionObserver 就直接亮出来 —— 宁可没有动效，也不能让内容永远看不见
    if (!io) {
      items.forEach((el) => el.classList.add('in'))
      return
    }
    items.forEach((el) => io.observe(el))
  }

  const route = useRoute()

  onMounted(scan)
  // 路由切换后是新 DOM，得重新扫一遍（等一帧，让视图先渲染出来）
  watch(
    () => route.fullPath,
    () => {
      void nextTick(scan)
    }
  )
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })
}
