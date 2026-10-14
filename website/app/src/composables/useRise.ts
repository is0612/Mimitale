import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'

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

  const router = useRouter()

  /**
   * ⚠️ 起点必须是 router.isReady()，不能是裸的 onMounted。
   *
   * Vue Router 的**首次导航是异步的**：onMounted 跑的那一刻 RouterView 里还是空的，
   * 这时 querySelectorAll('.rise') 拿到 0 个元素 —— 全站二十多个 .rise 于是
   * 永远没人 observe，全部停在 opacity: 0。页面看上去就是「只有 Hero 那几行字，
   * 往下全空」（2026-10-14 星宝报的「刚进去没有内容」就是这个）。
   *
   * 用 watch(() => route.fullPath) 兜也救不了：初始导航的 fullPath 从 '/' 到 '/'，
   * 值没变，watch 根本不触发。
   *
   * isReady() 在首次导航完成时 resolve；afterEach 覆盖之后每一次导航
   * （含 /download 那种懒加载组件 —— afterEach 时它已 resolve，下一个 tick DOM 就绪）。
   * ⛔ 以后新加 .rise 元素，仍然要走这两个时机，别用「等几秒再渲染」那种方式进场。
   */
  onMounted(async () => {
    await router.isReady()
    await nextTick()
    scan()
  })

  const stopAfterEach = router.afterEach(() => {
    void nextTick(scan)
  })

  onBeforeUnmount(() => {
    stopAfterEach()
    observer?.disconnect()
    observer = null
  })
}
