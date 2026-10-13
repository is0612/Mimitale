/**
 * 安装包清单的数据形状 —— 对应 `public/releases.json`。
 *
 * 加一个版本 = 往 releases.json 的 releases 数组里加一条，
 * 再把安装包丢进 `public/downloads/`，**不用改任何代码、不用重新构建前端**。
 */

export type ReleasePlatform = 'windows' | 'macos' | 'linux' | 'other'

/** 一个可下载的文件 */
export interface ReleaseAsset {
  platform: ReleasePlatform
  /** 按钮上的文字，比如「Windows 安装包 (.exe)」 */
  label: string
  /**
   * 文件地址。三种写法都行：
   *  · `/downloads/xxx.exe`  → 站内（放 public/downloads/ 里）
   *  · `https://...`         → 外链（CDN / GitHub Release 都行）
   *  · 留空字符串            → 只展示「待补」，按钮置灰
   */
  file: string
  /** 人类可读的体积，比如「78.2 MB」 */
  size?: string
  /** 校验值，可选。填了就显示出来，方便别人核对下载的东西没被动过 */
  sha256?: string
}

export interface Release {
  /** 版本号，比如 "0.1.0" */
  version: string
  /** 发布日期，ISO 写法 "2026-10-13" */
  date: string
  /** 这一版的一句话说明，可选 */
  title?: string
  /** 更细的更新说明，可选；按行拆开渲染 */
  notes?: string
  assets: ReleaseAsset[]
}

export interface ReleaseManifest {
  /** 最新版本号 —— 会被标成「最新」；没有安装包时留空字符串 */
  latest: string
  releases: Release[]
}
