'use strict';

// ============================================================================
//  main/account.js —— 账号体系的客户端实现（2026-10-27 接上真后端）
//
//  以前这里是「假后端」：账号存 data/account.json、验证码存主进程内存、
//  图形码答案也在本地。现在全部走 HTTP，逻辑在 server/src/routes/client/auth.ts。
//
//  ⚠️ 对外**形状一个字没改** —— ipc.js 那 12 个通道、preload、渲染层
//     （data/account.js、views/accountModal.js）全都不用动。
//     这是当初定「通道名和返回形状按真后端定」的回报。
//
//  ⚠️ 本地只留三样东西：accessToken、refreshToken、user 快照。
//     密码、凭证码、验证码**一个字都不落盘**。
//
//  ⚠️ 服务器不通时**不踢人**：已经登录的继续用缓存里的 user，聊天照常
//     （聊天本来就不经过账号服务器）。只有 token 真失效（401）才清登录态。
// ============================================================================

const { dataFile, writeJson, loadJsonWithFallback } = require('./store.js');
const crypto = require('node:crypto');

/**
 * 账号服务器地址。
 *
 * 现在是本机开发地址。买了域名之后改成 `https://api.你的域名.com/api`
 * —— 只改这一处（决策 5：别把 IP 硬编码进客户端，将来搬家是灾难）。
 */
const API_BASE = process.env.MIMITALE_API_BASE || 'http://127.0.0.1:8080/api';

/** 本地账号文件版本。1 = 老的假后端（accounts 数组），2 = 现在这套（token） */
const ACCOUNT_VERSION = 2;

/** 网络超时 —— 服务器不可达时别让人干等 */
const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
//  本地存储（只有 token 和 user 快照）
// ---------------------------------------------------------------------------

function accountFile() {
  return dataFile('account.json');
}

/**
 * 读本地登录态。
 *
 * ⚠️ version < 2 或结构不对的文件一律当「没登录」——
 *    老假后端的账号只在那个 JSON 里存在过，服务端根本没有，
 *    硬读出来只会让人以为还登着，然后每个请求都 401。
 */
function loadState() {
  const empty = { version: ACCOUNT_VERSION, token: '', refreshToken: '', user: null, pendingToken: '', pendingEmail: '' };

  let raw = null;
  try {
    raw = loadJsonWithFallback(accountFile());
  } catch (err) {
    console.warn('[account] 本地登录态读失败，按未登录处理:', err.message);
    return empty;
  }

  if (!raw || typeof raw !== 'object' || raw.version !== ACCOUNT_VERSION) return empty;

  return {
    version: ACCOUNT_VERSION,
    token: typeof raw.token === 'string' ? raw.token : '',
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : '',
    user: raw.user && typeof raw.user === 'object' ? raw.user : null,
    // 注册第一步到第二步之间的临时令牌（10 分钟），只活在这中间
    pendingToken: typeof raw.pendingToken === 'string' ? raw.pendingToken : '',
    pendingEmail: typeof raw.pendingEmail === 'string' ? raw.pendingEmail : ''
  };
}

function saveState(state) {
  return writeJson(accountFile(), state);
}

function patchState(patch) {
  const state = Object.assign(loadState(), patch);
  saveState(state);
  return state;
}

function clearSession() {
  return patchState({ token: '', refreshToken: '', user: null });
}

/** 当前登录用户（没登录返回 null） */
function currentUser() {
  const state = loadState();
  return state.token ? state.user : null;
}

// ---------------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------------

function networkError() {
  const err = new Error('连不上账号服务器，检查一下网络，或者稍后再试');
  err.network = true;
  return err;
}

/**
 * 发一个请求，返回 `data`。
 *
 * 约定（跟服务端一致）：
 *   - `code === 0` 成功
 *   - `code !== 0` 业务错误，message 是中英人话，直接抛给界面
 *   - HTTP 401 才是「登录失效」—— 这时自动用 refreshToken 换一次新 token 再重试，
 *     换不到才清登录态、让用户重新登
 *
 * `softAuth` = 「能带就带，不带也能用」：带上 token（服务端据此认出是谁），
 * 但 401 时**不**清登录态、也不弹「重新登录」。发反馈 / 拉公告走这个 ——
 * 公告本来就不要求登录，不该因为令牌过期把公告块整块打掉。
 */
async function request(method, pathname, options = {}) {
  const { body, auth = false, softAuth = false, token = '', headers: extraHeaders = {} } = options;

  const state = loadState();
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const bearer = token || (auth || softAuth ? state.token : '');
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    throw networkError();
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    // 临时令牌（注册第二步）换 token 是没意义的，直接报
    if (auth && !token && state.refreshToken && (await tryRefresh(state.refreshToken))) {
      return request(method, pathname, { body, auth, softAuth, token: '', headers: extraHeaders });
    }
    // softAuth 不清登录态：令牌过期只该影响「认出我是谁」，不该把公告也打掉
    if (!softAuth) clearSession();
    const err = new Error('登录已过期，重新登录一次');
    err.unauthorized = true;
    throw err;
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`账号服务器返回了看不懂的内容（HTTP ${res.status}）`);
  }

  if (payload.code !== 0) {
    throw new Error(payload.message || '操作失败');
  }

  return payload.data;
}

/** 用 refreshToken 换新 token；成功返回 true */
async function tryRefresh(refreshToken) {
  try {
    const res = await fetch(`${API_BASE}/client/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    const payload = await res.json();
    if (payload.code !== 0 || !payload.data || !payload.data.token) return false;
    patchState({ token: payload.data.token });
    return true;
  } catch {
    return false;
  }
}

/** 登录成功后统一落盘 */
function persistSession(data) {
  patchState({
    token: data.token || '',
    refreshToken: data.refreshToken || '',
    user: data.user || null,
    pendingToken: '',
    pendingEmail: ''
  });
  return { user: data.user || null };
}

// ---------------------------------------------------------------------------
//  对外能力 —— 名字和返回形状跟假后端那版一模一样
// ---------------------------------------------------------------------------

/**
 * 当前登录的账号。
 *
 * ⚠️ 服务器连不上时**保持登录**（用缓存里的 user）——
 *    账号服务器挂了不该导致所有人被踢下线、连聊天都用不了。
 *    只有 token 真的失效（401）才清。
 */
async function getSession() {
  const state = loadState();
  if (!state.token) return { user: null };

  try {
    const data = await request('GET', '/client/auth/me', { auth: true });
    // 顺手刷新本地快照 —— 头像/昵称可能在别的机器上改过
    patchState({ user: data.user });
    return { user: data.user };
  } catch (err) {
    if (err.unauthorized) return { user: null };
    console.warn('[account] 拉取会话失败，沿用本地快照:', err.message);
    return { user: currentUser() };
  }
}

/** 换一张图形校验码 → { id, image, expiresIn } */
async function createCaptcha() {
  return request('POST', '/client/auth/captcha');
}

/** 发邮箱验证码（必须先过图形码）→ { email, expiresIn, deliver, devCode? } */
async function sendEmailCode(payload) {
  const input = payload || {};
  return request('POST', '/client/auth/code', {
    body: {
      email: input.email,
      captchaId: input.captchaId,
      captchaAnswer: input.captchaAnswer
    }
  });
}

/** 注册第一步：邮箱 + 验证码 → { accountId, email, needsProfile } */
async function register(payload) {
  const input = payload || {};
  const data = await request('POST', '/client/auth/register', {
    body: { email: input.email, code: input.code }
  });

  // 第二步要用这张临时令牌，但**别给界面** —— 界面不需要，也就不会顺手塞进日志
  patchState({ pendingToken: data.pendingToken || '', pendingEmail: data.email || '' });

  return { accountId: data.accountId, email: data.email, needsProfile: data.needsProfile !== false };
}

/** 注册第二步：用户名 + 密码 + 头像（+ 邀请码，选填）→ 账号可用并直接登进去 */
async function completeProfile(payload) {
  const input = payload || {};
  const state = loadState();
  if (!state.pendingToken) throw new Error('注册信息过期了，重新来一遍');

  const data = await request('POST', '/client/auth/complete-profile', {
    body: {
      username: input.username,
      password: input.password,
      avatar: input.avatar,
      inviteCode: input.inviteCode || ''
    },
    token: state.pendingToken
  });

  return persistSession(data);
}

/** 邮箱 + 密码 + 图形码登录 */
async function login(payload) {
  const input = payload || {};
  const data = await request('POST', '/client/auth/login', {
    body: {
      email: input.email,
      password: input.password,
      captchaId: input.captchaId,
      captchaAnswer: input.captchaAnswer
    }
  });
  return persistSession(data);
}

/** 用 24 位凭证码登录（换机器 / 重装） */
async function loginWithVoucher(payload) {
  const input = payload || {};
  const data = await request('POST', '/client/auth/voucher-login', {
    body: { voucher: input.voucher }
  });
  return persistSession(data);
}

/**
 * 登出。
 * ⚠️ 服务器调用失败也要把本地清掉 —— 「点了登出却还登着」比「服务器不知道你走了」严重得多。
 */
async function logout() {
  const state = loadState();
  if (state.token) {
    try {
      await request('POST', '/client/auth/logout', { auth: true });
    } catch (err) {
      console.warn('[account] 通知服务器登出失败（本地照样清）:', err.message);
    }
  }
  clearSession();
  return { user: null };
}

/** 取登录凭证 → { code, username, email, avatar, createdAt, version } */
async function getVoucher() {
  return request('GET', '/client/auth/voucher', { auth: true });
}

/**
 * 换一张新凭证码 → 同形状。
 *
 * ⚠️ 旧码在服务端被**直接覆盖**，刷新成功那一刻之前导出的凭证图就都作废了。
 *    界面上必须先问一句再调。
 */
async function refreshVoucher() {
  return request('POST', '/client/auth/voucher/refresh', { auth: true });
}

/** 改资料（用户名 / 头像） */
async function updateProfile(payload) {
  const input = payload || {};
  const body = {};
  if (input.username != null) body.username = input.username;
  if (input.avatar != null) body.avatar = input.avatar;

  const data = await request('PATCH', '/client/auth/profile', { body, auth: true });
  patchState({ user: data.user });
  return { user: data.user };
}

/** 改密码（要当前密码）。改完不踢会话 —— 自己改的密码没必要让自己重登 */
async function changePassword(payload) {
  const input = payload || {};
  const data = await request('POST', '/client/auth/password', {
    body: { currentPassword: input.currentPassword, password: input.password },
    auth: true
  });
  return { user: data.user };
}

/** 改邮箱（要新邮箱收到的验证码） */
async function changeEmail(payload) {
  const input = payload || {};
  const data = await request('POST', '/client/auth/email', {
    body: { email: input.email, code: input.code },
    auth: true
  });
  patchState({ user: data.user });
  return { user: data.user };
}

// ---------------------------------------------------------------------------
//  消息：意见反馈 / 通知公告（2026-10-28）
// ---------------------------------------------------------------------------

/** 设备指纹文件 —— 只给发反馈的限频用，不参与任何身份识别 */
function deviceFile() {
  return dataFile('device.json');
}

let cachedDeviceId = '';

/**
 * 这台机器的随机指纹：第一次用到时生成一个 UUID 存下来，之后一直用它。
 *
 * ⚠️ 故意不掺 MAC / 主机名 / 用户名 —— 那类东西让人不安，换张网卡还会变。
 *    它只回答「是不是同一个人又发了一条」，不回答「这个人是谁」。
 * ⚠️ 没登录也能发反馈，服务端就靠它限频（60 秒一条、一天 10 条）。
 */
function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const raw = loadJsonWithFallback(deviceFile());
    if (raw && typeof raw.id === 'string' && raw.id) {
      cachedDeviceId = raw.id;
      return cachedDeviceId;
    }
  } catch (err) {
    console.warn('[account] 读设备指纹失败，重新生成:', err.message);
  }
  cachedDeviceId = crypto.randomUUID();
  // 落盘失败也无所谓：这一次照发，下次再生成一个（限频会松一点，不影响功能）
  Promise.resolve(writeJson(deviceFile(), { id: cachedDeviceId })).catch(() => {});
  return cachedDeviceId;
}

/**
 * 发一条意见反馈 → { id, createdAt }
 *
 * ⚠️ **不登录也能发**：新用户「连登录都进不去」的时候，恰恰是最需要报错的时候。
 *    登录了就顺带带上 token，服务端据此记下 customerId 和邮箱昵称。
 * @param {object} payload { kind, content, contactEmail }
 * @param {{appVersion?: string}} meta 版本号由 ipc.js 从 app.getVersion() 传进来
 */
async function submitFeedback(payload, meta = {}) {
  const input = payload || {};
  return request('POST', '/client/feedback', {
    body: {
      kind: input.kind || 'bug',
      content: input.content || '',
      contactEmail: input.contactEmail || '',
      appVersion: meta.appVersion || '',
      platform: process.platform,
      deviceId: deviceId()
    },
    softAuth: true
  });
}

/** 拉「此刻该显示」的公告 → { list, unread } */
async function listAnnouncements() {
  return request('GET', '/client/announcements', { softAuth: true });
}

/** 标一条已读 → { unread }。未登录时服务端回 unread: 0，客户端自己在本地记 */
async function markAnnouncementRead(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num <= 0) throw new Error('公告 id 不对');
  return request('POST', `/client/announcements/${num}/read`, { softAuth: true });
}

/**
 * 客户端使用会话上报。
 *
 * 一次「打开软件到关闭」对应服务端 client_sessions 里的一行：
 *   reportLaunch    启动时开新会话，拿回 sessionId
 *   reportHeartbeat 每 5 分钟报一次心跳（服务端据此算「用了多久」）
 *   reportExit      退出时报结束（quit / crash）
 *
 * ⚠️ 只在主进程里调，**不要**挂到 getSession 上 —— 设置页那颗「刷新」
 *    也走 getSession，那样一天能记十几次。
 * ⚠️ 失败一律静默：账号服务器挂了不该让用户看到报错弹窗。
 * ⚠️ 版本号由 main.js 传进来（account.js 是纯 HTTP 模块，不碰 electron）。
 */

/** 当前会话的 sessionId，启动后由 reportLaunch 填上 */
let currentSessionId = 0;

/** 心跳定时器；退出时清掉，别让它吊着进程 */
let heartbeatTimer = null;

/**
 * 启动上报 —— 开新会话，拿回 sessionId。
 * @param {string} appVersion 客户端版本号（main.js 从 app.getVersion() 取）
 */
async function reportLaunch(appVersion = '') {
  const state = loadState()
  if (!state.token) return;
  try {
    const data = await request('POST', '/client/auth/launch', {
      auth: true,
      headers: { 'x-app-version': appVersion }
    });
    currentSessionId = Number(data?.sessionId) || 0;
  } catch (err) {
    currentSessionId = 0;
    console.warn('[account] 启动上报失败（不影响使用）:', err.message);
  }
}

/**
 * 心跳 —— 每 5 分钟报一次，让服务端知道「这 5 分钟还在用」。
 * 服务端按天去重 + 内存合并，量级上不会打爆接口。
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!currentSessionId) return;
    const state = loadState();
    if (!state.token) return;
    // 失败静默 + 不 await：心跳丢了就丢了，下一次再报
    request('POST', '/client/auth/launch/ping', {
      auth: true,
      body: { sessionId: currentSessionId }
    }).catch((err) => console.warn('[account] 心跳失败（不影响使用）:', err.message));
  }, 5 * 60 * 1000);
  // 别让心跳 timer 吊住进程退出
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 退出上报 —— 结清当前会话。
 * @param {'quit'|'crash'} reason 正常退出 / 崩溃
 * @param {string} detail crash 时的补充（render-process-gone 的 reason 之类）
 */
function reportExit(reason = 'quit', detail = '') {
  if (!currentSessionId) return;
  const state = loadState();
  if (!state.token) return;
  // 用 fetch 直接发，不 await：进程马上要退了，等它返回反而拖慢退出
  fetch(`${API_BASE}/client/auth/launch/exit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ sessionId: currentSessionId, reason, detail })
  }).catch(() => {
    // 退出那一刻网络往往已经半死不活，写不写得到看运气；下次启动会兜底结清
  });
  stopHeartbeat();
}

module.exports = {
  getSession,
  reportLaunch,
  startHeartbeat,
  stopHeartbeat,
  reportExit,
  createCaptcha,
  sendEmailCode,
  register,
  completeProfile,
  login,
  loginWithVoucher,
  logout,
  getVoucher,
  refreshVoucher,
  updateProfile,
  changePassword,
  changeEmail,
  submitFeedback,
  listAnnouncements,
  markAnnouncementRead,
  // 给测试/排查用：当前账号服务器地址
  apiBase: API_BASE
};
