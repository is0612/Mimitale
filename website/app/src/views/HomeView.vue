<script setup lang="ts">
/**
 * 首页 —— 方向 A「深夜琥珀」，从方向稿 1:1 移植。
 *
 * 只有三处是「数组化」的（满屏重复的纯文字块），带行内标记的四张牌和小节保持
 * 手写 —— 那些文案各自不同，抽成数据反而更难改。
 */

import { SITE, DOC_LINKS } from '@/config/site'

const SCENES = [
  { no: '01', title: '和角色聊一场', desc: '导入你熟悉的角色卡，选一条开场白。从日常陪伴到剧情互动，让性格、语气和关系都有延续。' },
  { no: '02', title: '走进自己的世界', desc: '用世界书组织地点、阵营和背景，让 AI 以 GM 模式扮演世界与 NPC。你决定行动，故事逐轮展开。' },
  { no: '03', title: '试写另一种结局', desc: '调整叙述视角、推进节奏和文风预设，在分支与存档点之间试走不同路线，积累自己的故事素材。' }
]
const FAQ = [
  { q: '需要什么才能开始？', a: '一台电脑、一个支持的模型接口，以及对应的 API Key。源码运行还需要 Node.js 18+；安装包的可用平台以下载页实际发布内容为准。' },
  { q: '模型费用怎么算？', a: '客户端源码以 MIT 协议开放。模型调用费用由你选择的提供商按其规则收取，不包含在客户端里；长上下文、语义检索、生图和桌宠可能产生额外调用。' },
  { q: '需要好显卡，或者可以完全离线吗？', a: '默认通过 API 调用模型，不需要高性能显卡，但需要网络。也可以配置本机的 OpenAI 兼容服务；能否离线使用、运行什么模型，取决于该服务和你的硬件。' },
  { q: '酒馆角色卡能直接用吗？', a: '支持 SillyTavern PNG 角色卡与 JSON v1 / v2 / v3，读取设定、头像、开场白和示例对话，也会处理内嵌世界书。复杂扩展、脚本或非标准字段不保证完全兼容，导入后建议检查。' },
  { q: '长对话会一直记住所有细节吗？', a: '摘要、检索和状态面板帮助维持连续性，但模型仍可能遗漏或误判。重要设定建议写入世界书，关键数值交给状态面板，必要时编辑回复或回到存档点。' },
  { q: '换电脑如何迁移？', a: '在客户端打开数据文件夹，关闭程序后备份整个 data 目录。记录、角色和世界书可迁移；API Key 的加密与系统环境有关，换电脑后可能需要重新填写。当前不提供自动跨设备同步。' }
]

/** 长对话那三件东西 */
const FLOW = [
  { no: '01 / SUMMARY', title: '分段记忆摘要', desc: '较早的对话压成摘要常驻在上下文里。帮助保留重要人物、事件和约定，减少长剧情中的遗忘。' },
  { no: '02 / RAG', title: '语义检索（可选）', desc: '配置嵌入模型并启用后，按语义找回相关旧内容和设定。嵌入调用可能产生额外费用。' },
  { no: '03 / BRANCH', title: '分支与存档点', desc: '走岔了能整个退回来。想看看另一条路会怎样，不用重开一局。' }
]

/** 内置的模型平台（最后一个是「自定义」的虚位） */
const PILLS = ['DeepSeek', '通义千问', 'Kimi', '智谱 GLM', '腾讯混元', 'MiniMax']

/** 「每个会话记着自己用的模型」那张小示意 */
const SESSIONS = [
  { name: '银月酒馆 · 老板娘', model: 'deepseek-chat' },
  { name: '跑团记录 · 第三夜', model: 'qwen-max' },
  { name: '通用助手', model: 'glm-5.3' }
]
</script>

<template>
  <!-- ============================ Hero ============================ -->
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow"><i class="pulse"></i>桌面 AI 角色扮演 · 自带模型 API · MIT 开源</span>

      <h1>让角色有回应，<br>让故事由<span class="lit">你</span>续写</h1>

      <p class="lead">
        子夜酒馆（Mimitale）是运行在你电脑上的 AI 角色扮演与互动故事客户端。
        导入角色卡、搭建世界、追踪人物状态，用自己选择的模型，
        <strong>把一段对话，慢慢写成你的故事。</strong>
      </p>

      <div class="hero-cta">
        <RouterLink class="btn btn-primary" to="/download">下载与开始<span class="arw">→</span></RouterLink>
        <RouterLink class="btn btn-ghost" :to="{ path: '/', hash: '#pieces' }">看看它有什么</RouterLink>
      </div>

      <p class="hero-note">聊天记录保存在本机；生成回复需调用你配置的模型接口，费用按提供商规则计算。</p>

      <div class="facts">
        <div><b>角色</b> 与世界自由创作</div>
        <div><b>6</b> 家模型预设</div>
        <div><b>PNG / JSON</b> 角色卡导入</div>
        <div>记录 <b>本地保存</b></div>
      </div>
    </div>

    <!-- 用真实配色重建的客户端界面：比任何截图都更能说明「这东西长什么样」 -->
    <div class="wrap">
      <div class="stage rise">
        <div class="mock" role="img" aria-label="子夜酒馆客户端界面示意：左侧会话列表，中间对话，右侧状态面板">
          <div class="mock-chrome">
            <span class="pip"></span><span class="pip"></span><span class="pip"></span>
            <span class="addr">子夜酒馆 · 本地</span>
          </div>

          <div class="mock-body">
            <!-- 左栏 -->
            <aside class="m-side">
              <div class="m-brand">
                <span class="lampblock lampblock--sm" aria-hidden="true"></span>
                <span>子夜酒馆</span>
              </div>
              <div class="m-side-label">会话</div>
              <div class="m-convo on">
                <span class="ava g-amber">银</span>
                <span class="meta"><span class="nm">银月酒馆 · 老板娘</span></span>
                <span class="tm">10:41</span>
              </div>
              <div class="m-convo">
                <span class="ava g-rose">露</span>
                <span class="meta"><span class="nm">露西娅</span></span>
                <span class="tm">昨天</span>
              </div>
              <div class="m-convo">
                <span class="ava g-mint">通</span>
                <span class="meta"><span class="nm">通用助手</span></span>
                <span class="tm">周日</span>
              </div>
              <div class="m-convo">
                <span class="ava g-blue">我</span>
                <span class="meta"><span class="nm">跑团记录 · 第三夜</span></span>
                <span class="tm">周六</span>
              </div>
              <div class="m-side-foot">
                <span>设置</span><span>帮助</span>
              </div>
            </aside>

            <!-- 中栏 -->
            <div class="m-chat">
              <div class="m-head">
                <span class="charname">银月酒馆 · 老板娘</span>
                <span class="tag">世界书 ×3</span>
                <span class="model">deepseek-chat</span>
              </div>
              <div class="m-msgs">
                <div class="msg me">
                  <div class="who"><i class="pip me"></i>我</div>
                  <div class="body">擦干净杯子，靠到吧台上问她：今晚还有位置吗？</div>
                </div>
                <div class="msg">
                  <div class="who"><i class="pip ai"></i>老板娘</div>
                  <div class="body">
                    <span class="act">她把抹布往肩上一搭，抬眼看你，指尖在吧台上敲了两下。</span><br>
                    「有——靠窗那张，一直是空的。」<span class="delta">好感 62 → 66</span><br>
                    她顿了顿，又补了一句：「就是今晚，别坐那儿。」
                  </div>
                </div>
              </div>
              <div class="m-input">
                <span>说点什么…</span>
                <i class="caret" aria-hidden="true"></i>
              </div>
            </div>

            <!-- 右栏：状态面板（产品的招牌功能） -->
            <aside class="m-panel">
              <div class="m-panel-head">
                <span class="lampblock lampblock--sm" aria-hidden="true"></span>状态面板
              </div>
              <div class="m-group">
                <div class="m-group-t">关系</div>
                <div class="m-field">
                  <div class="k"><span>好感度</span><b>66 <span class="up">▲4</span></b></div>
                  <div class="m-bar"><i style="width: 66%"></i></div>
                </div>
                <div class="m-field">
                  <div class="k"><span>警惕</span><b>28</b></div>
                  <div class="m-bar is-cool"><i style="width: 28%"></i></div>
                </div>
              </div>
              <div class="m-group">
                <div class="m-group-t">当前</div>
                <div class="m-field">
                  <div class="k"><span>醉意</span><b>15</b></div>
                  <div class="m-bar is-ok"><i style="width: 15%"></i></div>
                </div>
                <div class="m-field">
                  <div class="k"><span>位置</span></div>
                  <div class="m-text">吧台 · 靠窗第二张空着</div>
                </div>
                <div class="m-field">
                  <div class="k"><span>随身</span></div>
                  <div class="m-chips"><span>铜钥匙</span><span>旧信</span></div>
                </div>
              </div>
              <div class="m-group">
                <div class="m-group-t">剧情选项</div>
              </div>
              <div class="m-opts">
                <div class="m-opt"><span class="n">1</span>追问为什么不能坐</div>
                <div class="m-opt"><span class="n">2</span>偏要坐过去</div>
              </div>
            </aside>
          </div>
        </div>
      </div>
      <p class="mock-caption">客户端界面示意 · 展示对话与状态面板，实际布局以当前版本为准</p>
    </div>
  </section>

  <section id="scenes" class="sec">
    <div class="wrap">
      <div class="sec-head rise"><span class="lampblock lampblock--sm" aria-hidden="true"></span><span class="sec-kicker">Your story</span></div>
      <h2 class="rise">今晚，你想从哪一幕开始？</h2>
      <p class="sec-sub rise">不只是问一句、答一句。让同一个角色、同一段关系、同一个世界，持续生长。</p>
      <div class="flow rise"><div v-for="scene in SCENES" :key="scene.no"><span class="n">{{ scene.no }}</span><h3>{{ scene.title }}</h3><p>{{ scene.desc }}</p></div></div>
    </div>
  </section>

  <!-- ============================ 四张牌 ============================ -->
  <section id="pieces" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Four pieces</span>
      </div>
      <h2 class="rise">角色卡管演谁，世界书管在哪儿<br>预设管怎么回，面板管状态怎么变</h2>
      <p class="sec-sub rise">
        从人物设定到世界规则，再到文风与数值，把影响体验的事情分开管理。
        <strong>想换一位主角，不必重写整个世界。</strong>
      </p>

      <div class="cards">
        <article class="card rise">
          <div class="card-no">01</div>
          <div>
            <h3 class="card-title">角色卡</h3>
            <div class="card-role">card</div>
          </div>
          <div>
            <p class="card-desc">
              导入 SillyTavern 的 <strong>PNG / JSON 角色卡</strong>，把设定、头像、开场白和示例对话一起带进来。
              也可以自己写角色、上传形象，为同一个人准备不同的入场剧本。
            </p>
            <span class="quote">用示例对话帮助模型理解语气；多条开场白，让同一个角色有不同的相遇方式。</span>
          </div>
        </article>

        <article class="card rise">
          <div class="card-no">02</div>
          <div>
            <h3 class="card-title">世界书</h3>
            <div class="card-role">lorebook</div>
          </div>
          <div>
            <p class="card-desc">
              <strong>关键词命中才注入</strong>。一本书几百条设定，只有相关的那几条进上下文 ——
              四两拨千斤。条目命中后正文还能再触发别的条目，一路连锁。
              可配置常驻条目、扫描深度和触发条件，让设定在合适的时候出现。
            </p>
            <span class="quote">用「命中预览」检查哪些条目会进入上下文，让复杂世界也有迹可循。</span>
          </div>
        </article>

        <article class="card rise">
          <div class="card-no">03</div>
          <div>
            <h3 class="card-title">预设</h3>
            <div class="card-role">preset</div>
          </div>
          <div>
            <p class="card-desc">
              叠在对话上的<strong>一层指令</strong> —— 管的不是「演谁」「在哪儿」，而是「怎么回」：
              人称、句式、篇幅密度、用词禁区、固定称呼。一场可挂多条，各自成块依次拼进提示词。
            </p>
            <span class="quote">说明与正文分离：说明只给人看，正文才进提示词。也能直接吃别人分享的预设。</span>
          </div>
        </article>

        <article class="card rise">
          <div class="card-no">04</div>
          <div>
            <h3 class="card-title">状态面板</h3>
            <div class="card-role">panel</div>
          </div>
          <div>
            <p class="card-desc">
              模型输出的状态栏会被<strong>解析并单独保存</strong>，下一轮再注入当前状态，
              减少历史截断带来的数值丢失。数值带范围，超出自动拉回；
              字段能分组、能带变化规则，还能给每轮几个可点的剧情选项。
            </p>
            <span class="quote">例如好感度范围设为 0–100，越界数值会被校正；状态更新仍依赖模型的有效输出。</span>
          </div>
        </article>
      </div>
    </div>
  </section>

  <!-- ============================ 长对话 ============================ -->
  <section id="memory" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Long play</span>
      </div>
      <h2 class="rise">让长剧情，有迹可循</h2>
      <p class="sec-sub rise">
        用摘要保留脉络，用语义检索找回相关细节，用分支尝试另一条路。
        减少反复解释背景，把上下文留给此刻正在发生的故事。
      </p>

      <div class="flow rise">
        <div v-for="item in FLOW" :key="item.no">
          <span class="n">{{ item.no }}</span>
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================ 多模型 ============================ -->
  <section id="models" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Any model</span>
      </div>
      <h2 class="rise">模型由你选，会话各自记住</h2>

      <div class="models">
        <div class="rise">
          <p class="sec-sub">
            内置 6 家国内常见平台的预设，点一下就能填好。其余平台 ——
            豆包、硅基流动、千帆、阶跃、星火、零一万物，以及境外的 ——
            只要对方是 <strong>OpenAI 兼容端点</strong>，填个地址就能用。
          </p>
          <div class="pills">
            <span v-for="name in PILLS" :key="name" class="pill">{{ name }}</span>
            <span class="pill plus">+ 自定义 OpenAI 兼容</span>
          </div>
          <p class="pill-note">
            可测试连接、拉取可用模型；接口兼容性与可用能力以提供商为准。
            API Key 使用系统级 <code>safeStorage</code> 加密后保存。
          </p>
        </div>

        <div class="rise">
          <div class="session-card">
            <div v-for="session in SESSIONS" :key="session.name" class="session-row">
              <span class="nm">{{ session.name }}</span>
              <span class="m">{{ session.model }}</span>
            </div>
          </div>
          <p class="session-cap">
            每个会话记着自己用的模型。在这边切了，那边一点不受影响；
            每条回答上还会标明是哪个模型答的，方便一较高下。
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================ 桌宠 ============================ -->
  <section id="pet" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Companion</span>
      </div>

      <div class="pet">
        <div class="rise">
          <p class="pet-quote">它不是你的化身，<br>是坐在旁边看你玩的小家伙。</p>
          <ul class="pet-points">
            <li>看得见你们的对话，<b>有自己的性格</b>，每隔几轮会插一句进来。</li>
            <li>有自己的记忆，也可以配自己的模型 —— 用便宜的那档跑就好。</li>
            <li><b>永不进剧情，也不写进对话记录。</b>它只是坐在旁边看着。</li>
          </ul>
        </div>

        <div class="pet-stage rise">
          <div class="pet-bubble">
            「你俩又聊到后半夜了……」
            <span>—— 它盯着屏幕，尾巴尖晃了一下</span>
          </div>
          <!-- 抽象的小生物：不指定物种，只给一个坐姿剪影。
               线/面/眼睛全部走 .fig-* 类读 token —— 底色一换，它跟着走。 -->
          <svg class="pet-figure" width="96" height="104" viewBox="0 0 96 104" fill="none" aria-hidden="true">
            <path class="fig-tail" d="M70 84 C88 82 92 70 84 62" stroke-width="7" stroke-linecap="round" />
            <path class="fig-body" d="M28 88 C16 88 12 78 16 66 C20 52 28 44 40 42 C52 40 62 46 66 58 C70 72 66 88 54 88 Z" stroke-width="2" />
            <path class="fig-body" d="M28 46 L24 30 L40 40 Z" stroke-width="2" />
            <path class="fig-body" d="M54 42 L60 26 L68 42 Z" stroke-width="2" />
            <circle class="fig-eye" cx="36" cy="60" r="3.4" />
            <circle class="fig-eye" cx="52" cy="59" r="3.4" />
            <path class="fig-mouth" d="M42 70 q2.5 3 6 0" stroke-width="1.6" stroke-linecap="round" fill="none" />
          </svg>
          <div class="pet-shadow"></div>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================ 隐私 ============================ -->
  <section id="privacy" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">No server</span>
      </div>
      <h2 class="rise">记录留在本机，数据流向说清楚</h2>
      <p class="sec-sub rise">
        角色、世界书和聊天记录保存在你的电脑上；生成回复时，
        <strong>所需的对话上下文会发送给你配置的模型提供商</strong>。
        本地保存不等于离线推理，也不等于内容从不联网。
      </p>

      <div class="privacy rise">
        <div class="privacy-grid">
          <div class="privacy-col them">
            <h3>本地保存的内容</h3>
            <div class="flowchart">
              <span class="node src">记录 · 角色 · 世界书</span>
              <span class="arw-line">──▶</span>
              <span class="node">本机数据目录</span>
            </div>
            <p>客户端在本地管理你的创作资料与会话，支持导出与手动备份。</p>
            <p>通过「打开数据文件夹」找到实际存储位置。当前不提供自动跨设备同步。</p>
          </div>

          <div class="privacy-col us">
            <h3>生成时发送的内容</h3>
            <div class="flowchart">
              <span class="node src">本机 · 必要上下文</span>
              <span class="arw-line">──▶</span>
              <span class="node local">你配置的模型 API</span>
            </div>
            <p>生成回复会发送所需的历史、角色设定与命中条目。模型平台如何处理数据，取决于其隐私政策。</p>
            <p>
              <b>生图、检索和桌宠</b>启用后也可能调用各自配置的接口。请勿把密钥、真实身份或其他敏感资料写入剧情。
            </p>
          </div>
        </div>

        <div class="privacy-foot">
          API Key 加密保存，但不是备份时可以随意分享的内容。迁移数据后可能需要重新配置 Key；
          分享作品时优先使用角色卡、世界书或对话导出，不要直接分享整个数据目录。
        </div>
      </div>
    </div>
  </section>

  <!-- ============================ 快速开始 ============================ -->
  <section id="start" class="sec">
    <div class="wrap">
      <div class="sec-head rise">
        <span class="lampblock lampblock--sm" aria-hidden="true"></span>
        <span class="sec-kicker">Get started</span>
      </div>
      <h2 class="rise">三步，开始你的第一场对话</h2>

      <ol class="flow onboarding rise">
        <li><span class="n">01 / OPEN</span><h3>获取并打开客户端</h3><p>到下载页查看已发布安装包，或按源码指南启动。Windows、macOS、Linux 的安装包以实际发布为准。</p><RouterLink class="text-link" to="/download">查看下载与运行方式 →</RouterLink></li>
        <li><span class="n">02 / CONNECT</span><h3>连接你的模型</h3><p>在「设置」选择提供商，填写 API Key 与模型，测试连接后保存。默认通过 API 生成，不需要高性能显卡。</p><a class="text-link" :href="DOC_LINKS[1].href" target="_blank" rel="noopener">阅读配置说明 ↗</a></li>
        <li><span class="n">03 / PLAY</span><h3>选一个角色，开聊</h3><p>在「角色库」点「导入角色卡」或新建角色，保存后点「聊天」。也可以新建空白对话，把它当作通用助手。</p><RouterLink class="text-link" :to="{ path: '/', hash: '#pieces' }">了解角色与世界 →</RouterLink></li>
      </ol>
    </div>
  </section>
  <section id="faq" class="sec">
    <div class="wrap">
      <div class="sec-head rise"><span class="lampblock lampblock--sm" aria-hidden="true"></span><span class="sec-kicker">Before you begin</span></div>
      <h2 class="rise">开始前，你可能想问</h2>
      <div class="faq-list rise"><details v-for="item in FAQ" :key="item.q"><summary>{{ item.q }}</summary><p>{{ item.a }}</p></details></div>
      <div class="closing rise"><div><h3>下一幕，轮到你落笔。</h3><p>准备好角色和 API Key，从一句开场白开始。</p></div><RouterLink class="btn btn-primary" to="/download">开始使用<span class="arw">→</span></RouterLink><a class="text-link" :href="SITE.repo" target="_blank" rel="noopener">查看源码 ↗</a></div>
    </div>
  </section>
</template>

<style scoped>
/* ==========================================================================
   首页各小节。全站共用的零件（按钮 / .sec / h2 / .rise / .lampblock …）
   在 styles/base.css 里，这里只放这一页自己的东西。
   ========================================================================== */

/* ------------------------------ 新手路径 ------------------------------ */
.hero-note, .mock-caption { color: var(--text-dim); font-size: 13px; line-height: 1.8; }
.hero-note { margin: var(--s4) 0 0; max-width: 640px; }
.mock-caption { text-align: center; margin: var(--s3) 0 0; }
.onboarding { list-style: none; padding: 0; margin: 0; }
.onboarding > li { background: var(--bg-side); padding: var(--s5); min-width: 0; }
.text-link { display: inline-block; color: var(--lamp); font-size: 14px; margin-top: var(--s4); }
.text-link:hover { text-decoration: underline; text-underline-offset: 4px; }
.faq-list { border-top: 1px solid var(--border); }
.faq-list details { border-bottom: 1px solid var(--border); }
.faq-list summary { cursor: pointer; padding: var(--s5) 0; font-size: 17px; font-weight: 600; }
.faq-list details[open] summary { color: var(--lamp); }
.faq-list p { color: var(--text-dim); max-width: 780px; margin: 0 0 var(--s5); line-height: 1.9; }
.closing { margin-top: var(--s8); border: 1px solid var(--border-hi); padding: var(--s6); display: flex; align-items: center; gap: var(--s5); flex-wrap: wrap; background: var(--lamp-a08); }
.closing > div { flex: 1 1 260px; }
.closing h3 { margin: 0; font-family: var(--font-serif); font-size: 26px; }
.closing p { color: var(--text-dim); margin: var(--s2) 0 0; }
.closing .text-link { margin-top: 0; }
/* ------------------------------ Hero ------------------------------ */
.hero {
  padding: 96px 0 0;
  position: relative;
}
.hero .wrap { max-width: 1180px; }

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.09em;
  color: var(--text-dim);
  text-transform: uppercase;
  padding: 6px 12px 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-side);
}
.eyebrow .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lamp);
  box-shadow: 0 0 0 3px var(--lamp-a14);
}

h1 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: clamp(38px, 6.2vw, 70px);
  line-height: 1.12;
  letter-spacing: 0.01em;
  margin: var(--s5) 0 0;
  text-wrap: balance;
}
/* 「深夜」两字：灯正好打在它上面 ——
   琥珀色的高亮铺在下三分之一（像荧光笔），外面再罩一圈很淡的光晕。
   ⚠️ 别用 ::after + z-index:-1 去做这道底光：.wrap 有自己的 stacking context，
   负 z 会被压到内容后面，等于白写（2026-10-13 实测那道光是「隐形」的）。 */
h1 .lit {
  color: var(--lamp);
  background-image: linear-gradient(180deg, transparent 68%, var(--lamp-a22) 68%);
  text-shadow: 0 0 46px color-mix(in srgb, var(--lamp) 42%, transparent);
  padding: 0 0.02em 0.05em;
}

.lead {
  font-size: clamp(16px, 1.45vw, 18px);
  line-height: 1.85;
  color: var(--text-dim);
  max-width: 620px;
  margin: var(--s5) 0 0;
}
.lead strong { color: var(--text); font-weight: 600; }

.hero-cta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s3);
  margin-top: var(--s6);
}

/* Hero 下方那排事实条：用竖线切分，不用卡片 */
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin-top: var(--s7);
  border-top: 1px solid var(--border);
  padding-top: var(--s4);
}
.facts div {
  font-size: 13px;
  color: var(--text-dim);
  padding: 0 var(--s5) 0 0;
  margin-right: var(--s5);
  border-right: 1px solid var(--border);
  line-height: 1.5;
}
.facts div:last-child { border-right: 0; margin-right: 0; padding-right: 0; }
.facts b { color: var(--lamp); font-weight: 600; font-family: var(--font-mono); }

/* ------------------------------ 产品界面模型 ------------------------------ */
.stage {
  margin-top: var(--s8);
  position: relative;
}
.stage::before {
  content: "";
  position: absolute;
  /* ⚠️ 左右不要用负 inset —— 它会顶宽文档（1024px 实测多出 10px，
     html 层面 scrollWidth 压不下去）。上下收窄已经够造出「灯洒下来」的形状。 */
  inset: -8% 0 20%;
  background: radial-gradient(60% 55% at 50% 30%, var(--lamp-a08), transparent 70%);
  pointer-events: none;
}

.mock {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  overflow: hidden;
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
}
.mock-chrome {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
}
.mock-chrome .pip { width: 10px; height: 10px; border-radius: 2px; background: var(--border-hi); }
.mock-chrome .addr {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  margin-left: auto;
  letter-spacing: 0.04em;
}

.mock-body {
  display: grid;
  grid-template-columns: 208px 1fr 236px;
  height: 452px;
  font-size: 12px;
  line-height: 1.5;
}

/* — 左栏 — */
.m-side {
  background: var(--bg-side);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.m-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 13px 12px 12px;
}
.m-brand span {
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.05em;
}
.m-side-label {
  font-size: 11px;
  color: var(--text-faint);
  padding: 8px 14px 5px;
  letter-spacing: 0.08em;
}
.m-convo {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  margin: 1px 6px;
  border-radius: var(--radius-sm);
}
.m-convo.on { background: var(--bg-item); }
.m-convo .ava {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--on-lamp);
}
.g-amber { background: linear-gradient(135deg, #ffd9a8, #ffab5e); }
.g-rose  { background: linear-gradient(135deg, #ffb0d0, #b98cff); }
.g-mint  { background: linear-gradient(135deg, #b9f0d8, #5fd6a8); }
.g-blue  { background: linear-gradient(135deg, #9fd4ff, var(--cool)); }
.m-convo .meta { min-width: 0; flex: 1; }
.m-convo .nm {
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-convo:not(.on) .nm { color: var(--text-dim); }
.m-convo .tm { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); flex: none; }
.m-side-foot {
  margin-top: auto;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-faint);
  display: flex;
  justify-content: space-between;
}

/* — 中栏 — */
.m-chat { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.m-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
}
.m-head .charname { font-size: 13px; font-weight: 600; color: var(--text); }
.m-head .tag {
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 2px 7px;
  border-radius: var(--radius-sm);
}
.m-head .model {
  margin-left: auto;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--lamp);
  border: 1px solid var(--lamp-a22);
  background: var(--lamp-a08);
  padding: 3px 9px;
  border-radius: var(--radius-sm);
}
.m-msgs { padding: 14px 16px; display: flex; flex-direction: column; gap: 15px; overflow: hidden; }
.msg .who {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.msg .who .pip { width: 5px; height: 5px; border-radius: 50%; }
.msg .who .pip.me { background: var(--cool); }
.msg .who .pip.ai { background: var(--lamp); }
.msg.me .body { color: var(--text-dim); }
.msg .body { color: var(--text); line-height: 1.75; }
.msg .body .act { color: var(--lamp); }
/* 数值变化就写在句子里 —— 这是这个产品最该被看见的一屏 */
.msg .delta {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 25%, transparent);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  margin-left: 3px;
}
.m-input {
  /* ⚠️ margin-top:auto 必须写在 margin 简写**后面**：简写会把四个方向一起重置，
     写在前面等于没写，输入框就不贴底了（2026-10-14 前一直是这样失效的） */
  margin: 12px 16px 16px;
  margin-top: auto;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-faint);
  font-size: 12px;
}
.caret {
  width: 1.5px;
  height: 14px;
  background: var(--lamp);
  animation: blink 1.1s steps(2, start) infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* — 右栏：状态面板 — */
.m-panel {
  background: var(--bg-side);
  border-left: 1px solid var(--border);
  overflow: hidden;
  padding-bottom: 12px;
}
.m-panel-head {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 7px;
}
.m-group { padding: 11px 14px 4px; }
.m-group-t {
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-faint);
  margin-bottom: 9px;
}
.m-field { margin-bottom: 11px; }
.m-field .k {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.m-field .k b { color: var(--text); font-family: var(--font-mono); font-weight: 600; }
.m-field .k .up { color: var(--ok); }
.m-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-input);
  overflow: hidden;
}
.m-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--lamp);
}
.m-bar.is-cool i { background: var(--cool); }
.m-bar.is-ok i { background: var(--ok); }
.m-text { font-size: 11.5px; color: var(--text); }
.m-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.m-chips span {
  font-size: 10.5px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.m-opts { padding: 6px 14px 0; display: flex; flex-direction: column; gap: 6px; }
.m-opt {
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
  display: flex;
  gap: 7px;
  align-items: center;
}
.m-opt .n { font-family: var(--font-mono); color: var(--lamp); font-size: 10.5px; }
.m-opt:hover { border-color: var(--lamp-a35); color: var(--text); }

/* ------------------------------ 四张牌 ------------------------------ */
/* 刻意不用卡片：大衬线编号 + 细线分隔的「条目」，读起来像一份目录。
   满页卡片的官网是最典型的 AI 味。 */
.cards { border-top: 1px solid var(--border); }
.card {
  display: grid;
  /* 编号 | 标题 | 描述。标题列给死宽度，否则它那三五个字会撑出一片空洞 */
  grid-template-columns: 96px 220px minmax(0, 1fr);
  gap: var(--s6);
  padding: var(--s7) 0;
  border-bottom: 1px solid var(--border);
  align-items: start;
}
.card-no {
  font-family: var(--font-serif);
  font-size: 44px;
  line-height: 0.9;
  color: var(--border-hi);
  font-weight: 400;
  letter-spacing: -0.02em;
  transition: color 0.35s var(--ease);
}
.card:hover .card-no { color: var(--lamp); }
.card-title {
  font-family: var(--font-serif);
  font-size: 23px;
  font-weight: 600;
  margin: 0 0 6px;
  letter-spacing: 0.01em;
}
.card-role {
  font-size: 13px;
  color: var(--lamp);
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}
.card-desc {
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1.85;
  margin: 0;
  /* 收窄到约 42 字一行 —— 再宽右边缘就散了，也失去杂志式的留白 */
  max-width: 620px;
}
.card-desc strong { color: var(--text); font-weight: 600; }
.card .quote {
  display: block;
  margin-top: var(--s4);
  padding-left: 13px;
  border-left: 2px solid var(--lamp-a35);
  color: var(--text);
  font-size: 14px;
}

/* ------------------------------ 长对话（三段式） ------------------------------ */
.flow {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.flow > div {
  background: var(--bg-side);
  padding: var(--s5) var(--s5) var(--s6);
}
.flow .n {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--lamp);
  letter-spacing: 0.1em;
  display: block;
  margin-bottom: var(--s3);
}
.flow h3 {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 var(--s2);
  font-family: var(--font-ui);
}
.flow p {
  font-size: 14px;
  color: var(--text-dim);
  margin: 0;
  line-height: 1.8;
}

/* ------------------------------ 多模型 ------------------------------ */
.models {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  gap: var(--s8);
  align-items: center;
}
/* 「多模型」那节的说明文字跟左列标签同处一块，下面收得比整段小节紧一档 */
.models .sec-sub { margin-bottom: var(--s5); }

.pills { display: flex; flex-wrap: wrap; gap: var(--s2); }
.pill {
  font-size: 13.5px;
  color: var(--text);
  border: 1px solid var(--border-hi);
  background: var(--bg-side);
  padding: 8px 14px;
  border-radius: var(--radius);
  letter-spacing: 0.01em;
}
.pill.plus { border-style: dashed; color: var(--text-dim); }
.pill-note {
  font-size: 13.5px;
  color: var(--text-faint);
  margin-top: var(--s4);
  line-height: 1.8;
}
.session-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-side);
  padding: var(--s4);
}
.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.session-row + .session-row { border-top: 1px solid var(--border); }
.session-row .nm { color: var(--text-dim); flex: 1; }
.session-row .m {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--lamp);
  border: 1px solid var(--lamp-a22);
  background: var(--lamp-a08);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.session-cap {
  font-size: 12px;
  color: var(--text-faint);
  margin: var(--s3) 0 0;
  line-height: 1.7;
}

/* ------------------------------ 桌宠 ------------------------------ */
.pet {
  display: grid;
  grid-template-columns: 1fr 0.85fr;
  gap: var(--s8);
  align-items: center;
}
.pet-quote {
  font-family: var(--font-serif);
  font-size: clamp(19px, 2.2vw, 25px);
  line-height: 1.6;
  color: var(--text);
  border-left: 2px solid var(--lamp);
  padding-left: var(--s5);
  margin: 0 0 var(--s5);
}
.pet-points { list-style: none; padding: 0; margin: 0; }
.pet-points li {
  font-size: 15px;
  color: var(--text-dim);
  padding: 9px 0 9px 20px;
  position: relative;
  line-height: 1.7;
}
.pet-points li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 17px;
  width: 7px;
  height: 7px;
  border-radius: 1px;
  background: var(--lamp);
  opacity: 0.7;
}
.pet-points li b { color: var(--text); font-weight: 600; }

/* 桌宠示意：一块屏幕的一角，它坐在上面 */
.pet-stage {
  aspect-ratio: 1 / 0.86;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(180deg, var(--bg-side), var(--bg));
  position: relative;
  overflow: hidden;
}
.pet-stage::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--border-hi);
}
.pet-bubble {
  position: absolute;
  top: 18%;
  left: 8%;
  max-width: 62%;
  background: var(--bg-card);
  border: 1px solid var(--border-hi);
  border-radius: var(--radius);
  padding: 10px 13px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.65;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}
.pet-bubble span { color: var(--text-faint); font-size: 11px; display: block; margin-top: 4px; }
.pet-figure { position: absolute; right: 9%; bottom: 0; }
/* 剪影的线/面/眼睛/嘴全读 token，不写死色值 —— 底色一换，它跟着走 */
.pet-figure .fig-tail { stroke: var(--border-hi); fill: none; }
.pet-figure .fig-body { fill: var(--bg-item); stroke: var(--border-hi); }
.pet-figure .fig-eye { fill: var(--lamp); }
.pet-figure .fig-mouth { stroke: var(--text-faint); }
.pet-shadow {
  position: absolute;
  right: 11%;
  bottom: 4px;
  width: 84px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(0, 0, 0, 0.6), transparent);
}

/* ------------------------------ 隐私对照 ------------------------------ */
.privacy {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.privacy-grid { display: grid; grid-template-columns: 1fr 1fr; }
.privacy-col { padding: var(--s6); }
.privacy-col.them { background: var(--bg-side); border-right: 1px solid var(--border); }
.privacy-col.us { background: linear-gradient(180deg, var(--lamp-a08), transparent 70%); }
.privacy-col h3 {
  font-size: 13px;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 var(--s5);
  color: var(--text-faint);
  display: flex;
  align-items: center;
  gap: 8px;
}
.privacy-col.us h3 { color: var(--lamp); }
.flowchart {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  margin-bottom: var(--s5);
}
.node {
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  padding: 7px 11px;
  color: var(--text-dim);
  background: var(--bg);
}
.node.src { color: var(--text); }
.node.cloud { border-color: var(--bad-border); color: var(--bad); background: var(--bad-bg); }
.node.local {
  border-color: var(--lamp-a35);
  color: var(--lamp);
  background: var(--lamp-a08);
}
.arw-line { color: var(--text-faint); font-family: var(--font-mono); }
.privacy-col p {
  font-size: 14px;
  color: var(--text-dim);
  margin: 0 0 var(--s3);
  line-height: 1.8;
}
.privacy-col p b { color: var(--text); font-weight: 600; }
.privacy-col.us p b { color: var(--lamp); }
.privacy-foot {
  border-top: 1px solid var(--border);
  padding: var(--s5) var(--s6);
  background: var(--bg-side);
  font-size: 13.5px;
  color: var(--text-dim);
  line-height: 1.8;
}

/* ------------------------------ 快速开始 ------------------------------ */
/* 终端框 + 步骤表的样式在 base.css（与下载页共用一份），这里只留本页的布局关系 */

/* ------------------------------ 响应式 ------------------------------ */
@media (max-width: 1080px) {
  /* 高度别跟着栏宽一起缩 —— 右栏那三组字段的高度是死的，
     缩到 430 会把最下面的「剧情选项」切掉 20px（1024px 实测） */
  .mock-body { grid-template-columns: 190px 1fr 214px; height: 452px; }
  .card { grid-template-columns: 84px 1fr; gap: var(--s5); }
  .card > div:last-child { grid-column: 2; }
  .card-no { font-size: 36px; }
  .models,
  .pet,
  .start { grid-template-columns: 1fr; gap: var(--s6); }
  .pet-stage { order: -1; }
}
@media (max-width: 860px) {
  .hero { padding-top: 64px; }
  .mock-body { grid-template-columns: 168px 1fr; height: 400px; }
  .m-panel { display: none; }
  .flow { grid-template-columns: 1fr; }
  .privacy-grid { grid-template-columns: 1fr; }
  .privacy-col.them { border-right: 0; border-bottom: 1px solid var(--border); }
  .facts div { border-right: 0; padding: var(--s2) var(--s5) var(--s2) 0; }
}
@media (max-width: 620px) {
  .mock-body { grid-template-columns: 1fr; height: 380px; }
  .m-side { display: none; }
  .m-head { flex-wrap: wrap; }
  .m-head .model { margin-left: 0; }
  .card { grid-template-columns: 1fr; }
  .card > div:last-child { grid-column: 1; }
  .card-no { font-size: 28px; }
  .hero-cta .btn { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .caret { animation: none; }
}
</style>
