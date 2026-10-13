/** 站点级的固定文案与地址。改名字、改仓库地址，只动这一个文件。 */

export const SITE = {
  name: '子夜酒馆',
  latin: 'Nocturne Tavern',
  tagline: '一间只在深夜开门的酒馆',
  /** 客户端仓库（页脚「GitHub 仓库」指向这里） */
  repo: 'https://github.com/ls546280821/Mimitale',
  license: 'MIT'
} as const

/**
 * 页脚「文档」那一列。
 * ⚠️ 仓库里的文档在根目录，文件名是中文；如果哪天默认分支不叫 main，改这里的 branch。
 */
const BRANCH = 'main'

export const DOC_LINKS = [
  { label: 'GitHub 仓库', href: SITE.repo, external: true },
  { label: '使用说明', href: `${SITE.repo}/blob/${BRANCH}/使用说明.md`, external: true },
  { label: '变更记录', href: `${SITE.repo}/blob/${BRANCH}/CHANGELOG.md`, external: true }
] as const

/** 首页内部锚点。顶栏导航和页脚都要用，所以放一处。 */
export const HOME_SECTIONS = [
  { id: 'pieces', label: '功能' },
  { id: 'memory', label: '长对话' },
  { id: 'pet', label: '桌宠' },
  { id: 'privacy', label: '隐私' },
  { id: 'start', label: '快速开始' }
] as const
