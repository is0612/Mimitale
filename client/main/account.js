'use strict';

// ============================================================================
//  main/account.js —— 账号体系的「假后端」（2026-10-23）
//
//  服务器还没买（腾讯云香港那台还在购物车里），但登录流程要能真走一遍：
//  图形校验码 → 发邮箱验证码 → 两步注册 → 密码登录 → 凭证码登录 → 导出凭证。
//
//  ⚠️ 每个函数都是**按真实后端的接口形状**写的：接服务器时把函数体换成一次
//     fetch / 本地代理，渲染层（views/accountModal.js、data/account.js）一行都不用改。
//
//  ⚠️ 假后端的三处妥协（真后端必须改掉，注释里都标了「真后端」）：
//     1. 图形校验码和答案都留在主进程内存里；
//     2. 邮箱验证码没真发出去 —— 直接把码回给界面显示（`devCode`）；
//     3. 账号数据落在本机 data/account.json，不是数据库，也没有并发控制。
//
//  ⚠️ 密码只存 scrypt 加盐哈希，任何时候都不回传明文（连长度都不回）。
// ============================================================================

const crypto = require('node:crypto');

const { dataFile, writeJson, loadJsonWithFallback } = require('./store.js');

/** 当前格式版本；将来加字段（比如云同步开关）时按它升级 */
const ACCOUNT_VERSION = 1;

/** 图形校验码：5 分钟过期，一次性（错了也作废，前端自动换一张） */
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

/** 邮箱验证码：10 分钟有效，60 秒内不许重发，最多试 5 次 */
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_TRIES = 5;

/** 头像存进 JSON 的体积上限（base64 字符数，约 300KB → 原图 220KB 左右） */
const MAX_AVATAR_CHARS = 400 * 1000;

/** 校验码字符集：去掉 0/O/1/I/L 这些抄错就说不清的 */
const CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// --- 只在内存里的运行态（重启即失效，和真后端「会话 / 待验证码」的语义一致） ---
/** captchaId → { answer, expiresAt } */
const captchas = new Map();
/** 邮箱 → { code, expiresAt, sentAt, tries } */
const emailCodes = new Map();

// ---------------------------------------------------------------------------
//  存储
// ---------------------------------------------------------------------------

function accountFile() {
  return dataFile('account.json');
}

/** 读账号库；文件不存在 / 读坏都当空库，不拦启动 */
function loadState() {
  let raw = null;
  try {
    raw = loadJsonWithFallback(accountFile());
  } catch (err) {
    console.warn('[account] 账号文件读失败，按空库处理:', err.message);
  }
  const data = raw && typeof raw === 'object' ? raw : {};
  const accounts = Array.isArray(data.accounts)
    ? data.accounts.filter((a) => a && typeof a.email === 'string' && a.id)
    : [];
  const session =
    data.session && data.session.accountId && accounts.some((a) => a.id === data.session.accountId)
      ? data.session
      : null;
  return { version: ACCOUNT_VERSION, accounts, session };
}

function saveState(state) {
  return writeJson(accountFile(), {
    version: ACCOUNT_VERSION,
    accounts: state.accounts,
    session: state.session
  });
}

function currentAccount(state) {
  const data = state || loadState();
  if (!data.session) return null;
  return data.accounts.find((a) => a.id === data.session.accountId) || null;
}

/** 对外的账号形状：**不含密码哈希和盐**，也不含凭证码（要单独取） */
function publicUser(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    username: account.username || '',
    avatar: account.avatar || '',
    createdAt: account.createdAt || '',
    profileReady: !!account.profileReady
  };
}

// ---------------------------------------------------------------------------
//  校验与规整
// ---------------------------------------------------------------------------

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('邮箱格式不对，检查一下');
  if (email.length > 120) throw new Error('邮箱太长了');
  return email;
}

function normalizeUsername(value) {
  const name = String(value || '').trim();
  if (name.length < 2) throw new Error('用户名至少 2 个字');
  if (name.length > 20) throw new Error('用户名最多 20 个字');
  return name;
}

function normalizePassword(value) {
  const password = String(value == null ? '' : value);
  if (password.length < 8) throw new Error('密码至少 8 位');
  if (password.length > 128) throw new Error('密码最多 128 位');
  return password;
}

/** 头像只收图片 data URL；超过上限就报错（前端会先压到 256×256 再传） */
function normalizeAvatar(value) {
  const avatar = String(value || '').trim();
  if (!avatar) return '';
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) {
    throw new Error('头像格式不认识（只收 PNG / JPEG / WebP）');
  }
  if (avatar.length > MAX_AVATAR_CHARS) throw new Error('头像太大了，换一张小一点的');
  return avatar;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function makeVoucher() {
  // 24 个字符，每 4 位一组：XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  // ⚠️ 别用 `byte % 32` 取字符：上面那套字符集只有 31 个（去掉了 0/O/1/I/L），
  //    下标 31 会取到 undefined，拼出来就是 `...-NKEu-ndef-ined-...` 这种鬼东西。
  //    randomInt 是无偏的，顺便把「31 不是 2 的幂」那点模偏差也绕开了。
  const chars = [];
  for (let i = 0; i < 24; i += 1) chars.push(VOUCHER_ALPHABET[crypto.randomInt(0, VOUCHER_ALPHABET.length)]);
  return chars.join('').match(/.{4}/g).join('-');
}

/** 凭证码容忍大小写、空格、少写/多写连字符 —— 手抄过的人都知道 */
function normalizeVoucher(value) {
  const raw = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!raw) throw new Error('先填凭证码');
  if (raw.length !== 24) throw new Error('凭证码是 24 位，检查一下有没有抄漏');
  return raw.match(/.{4}/g).join('-');
}

// ---------------------------------------------------------------------------
//  图形校验码
// ---------------------------------------------------------------------------

function randomAnswer(length = 4) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CAPTCHA_CHARS[crypto.randomInt(0, CAPTCHA_CHARS.length)];
  return out;
}

/**
 * 画一张 4 位字符的 SVG 校验码。
 * ⚠️ 用 SVG 而不是 canvas：主进程没有 canvas，而 SVG 拼字符串就够了；
 *    没有可见文字要求，字符集也限制在 A-Z2-9，插进属性里不会有转义问题。
 */
function captchaSvg(answer) {
  const width = 112;
  const height = 40;
  const parts = [];

  // 底色 + 边框（内联属性，避免依赖外部样式）
  parts.push(`<rect width="${width}" height="${height}" rx="4" fill="#1d2126"/>`);

  // 背景噪点：细碎的点比噪线更耐看，也不会把字符压糊
  for (let i = 0; i < 26; i += 1) {
    const x = crypto.randomInt(2, width - 2);
    const y = crypto.randomInt(2, height - 2);
    parts.push(`<circle cx="${x}" cy="${y}" r="0.8" fill="#3b4249"/>`);
  }

  // 两条干扰曲线
  for (let i = 0; i < 2; i += 1) {
    const y1 = crypto.randomInt(6, height - 6);
    const y2 = crypto.randomInt(6, height - 6);
    const cy1 = crypto.randomInt(0, height);
    const cy2 = crypto.randomInt(0, height);
    parts.push(
      `<path d="M0 ${y1} C ${width * 0.3} ${cy1}, ${width * 0.7} ${cy2}, ${width} ${y2}" ` +
        'fill="none" stroke="#4a535c" stroke-width="1.2"/>'
    );
  }

  // 字符：每个自己转一个角度、上下错开，别排成一条直线
  const step = width / (answer.length + 1);
  for (let i = 0; i < answer.length; i += 1) {
    const x = Math.round(step * (i + 1));
    const y = Math.round(height / 2 + crypto.randomInt(-3, 4));
    const rotate = crypto.randomInt(-22, 23);
    const size = crypto.randomInt(20, 25);
    const color = ['#e8e4d8', '#cbb88f', '#a9c2b0'][crypto.randomInt(0, 3)];
    parts.push(
      `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" ` +
        `font-family="Consolas, monospace" font-size="${size}" font-weight="700" ` +
        `fill="${color}" transform="rotate(${rotate} ${x} ${y})">${answer[i]}</text>`
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 发一张新的图形校验码（旧的留着自然过期） */
function createCaptcha() {
  // 顺手清掉过期项，别让 Map 无限长
  const now = Date.now();
  for (const [id, item] of captchas) if (item.expiresAt < now) captchas.delete(id);

  const id = crypto.randomUUID();
  const answer = randomAnswer();
  captchas.set(id, { answer, expiresAt: now + CAPTCHA_TTL_MS });
  const result = { id, image: captchaSvg(answer), expiresIn: Math.round(CAPTCHA_TTL_MS / 1000) };
  // ⚠️ 只有自动测试（tools/smoke-test.js 设了 MIMITALE_ACCOUNT_TEST=1）能看到答案，
  //    否则一张图没人认得出来、整条注册 / 登录链路就没法自动跑。
  //    真后端：答案只留服务端，**任何情况下都不回给前端**。
  if (process.env.MIMITALE_ACCOUNT_TEST === '1') result.answer = answer;
  return result;
}

/** 验图形码：**一次性**，不管对错都作废（对的那次也作废，防重放） */
function checkCaptcha(captchaId, answer) {
  const id = String(captchaId || '');
  const item = captchas.get(id);
  if (!item) throw new Error('校验码已失效，点图片换一张');
  captchas.delete(id);
  if (item.expiresAt < Date.now()) throw new Error('校验码过期了，点图片换一张');
  if (String(answer || '').trim().toUpperCase() !== item.answer) {
    throw new Error('校验码不对，换一张再试');
  }
}

// ---------------------------------------------------------------------------
//  对外能力
// ---------------------------------------------------------------------------

/** 当前登录的账号（没登录返回 null） */
async function getSession() {
  return { user: publicUser(currentAccount()) };
}

/**
 * 发邮箱验证码。
 * ⚠️ 星宝的口径：**图形校验码先过，才给邮箱发码** —— 所以这里是先验图形码。
 * 真后端：验完码调 SMTP / 邮件 API，绝不把 code 回给前端。
 */
async function sendEmailCode(payload) {
  const request = payload || {};
  const email = normalizeEmail(request.email);

  checkCaptcha(request.captchaId, request.captchaAnswer);

  const state = loadState();
  if (state.accounts.some((a) => a.email === email)) {
    // 真后端也不该在这里暴露「邮箱是否注册」，但注册流程里报清楚更省事；
    // 等有风控要求时改成「无论是否注册都返回成功」。
    throw new Error('这个邮箱已经注册过了，直接登录');
  }

  const now = Date.now();
  const prev = emailCodes.get(email);
  if (prev && now - prev.sentAt < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - prev.sentAt)) / 1000);
    throw new Error(`刚发过一封，${wait} 秒后再试`);
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  emailCodes.set(email, { code, expiresAt: now + CODE_TTL_MS, sentAt: now, tries: 0 });

  // 真后端：这里只返回 { ok: true, expiresIn }，绝不带 devCode
  return {
    email,
    expiresIn: Math.round(CODE_TTL_MS / 1000),
    deliver: 'dev',
    devCode: code
  };
}

/** 注册第一步：邮箱 + 验证码 → 先建一个「还没设资料」的空账号 */
async function register(payload) {
  const request = payload || {};
  const email = normalizeEmail(request.email);
  const code = String(request.code || '').trim();

  const entry = emailCodes.get(email);
  if (!entry || entry.expiresAt < Date.now()) throw new Error('验证码过期了，重新获取');
  if (entry.tries >= CODE_MAX_TRIES) throw new Error('试错次数太多，重新获取验证码');
  if (code !== entry.code) {
    entry.tries += 1;
    throw new Error('验证码不对，再看看邮件');
  }
  emailCodes.delete(email);

  const state = loadState();
  if (state.accounts.some((a) => a.email === email)) throw new Error('这个邮箱注册过了，直接登录');

  const account = {
    id: crypto.randomUUID(),
    email,
    username: '',
    avatar: '',
    salt: '',
    passwordHash: '',
    voucher: '',
    profileReady: false,
    createdAt: new Date().toISOString()
  };
  state.accounts.push(account);
  await saveState(state);

  // 真后端会回一个「临时注册令牌」，第二步带着它走；这里直接用 accountId
  return { accountId: account.id, email, needsProfile: true };
}

/** 注册第二步：头像 + 用户名 + 密码 → 账号正式可用，并直接登进去 */
async function completeProfile(payload) {
  const request = payload || {};
  const username = normalizeUsername(request.username);
  const password = normalizePassword(request.password);
  const avatar = normalizeAvatar(request.avatar);

  const state = loadState();
  const account = state.accounts.find((a) => a.id === String(request.accountId || ''));
  if (!account) throw new Error('注册信息过期了，重新来一遍');
  if (account.profileReady) throw new Error('这个账号已经设置过了');

  const salt = crypto.randomBytes(16).toString('hex');
  account.username = username;
  account.salt = salt;
  account.passwordHash = hashPassword(password, salt);
  account.avatar = avatar;
  account.voucher = makeVoucher();
  account.profileReady = true;

  state.session = {
    accountId: account.id,
    token: crypto.randomUUID(),
    at: new Date().toISOString()
  };
  await saveState(state);
  return { user: publicUser(account) };
}

/** 邮箱 + 密码登录（图形码这道和「发验证码」一样，先验） */
async function login(payload) {
  const request = payload || {};
  const email = normalizeEmail(request.email);

  checkCaptcha(request.captchaId, request.captchaAnswer);

  const state = loadState();
  const account = state.accounts.find((a) => a.email === email);
  // ⚠️ 「邮箱不存在」和「密码不对」给同一句 —— 别让人拿登录页探邮箱
  const bad = new Error('邮箱或密码不对');
  if (!account || !account.profileReady) throw bad;
  if (hashPassword(String(request.password || ''), account.salt) !== account.passwordHash) throw bad;

  state.session = {
    accountId: account.id,
    token: crypto.randomUUID(),
    at: new Date().toISOString()
  };
  await saveState(state);
  return { user: publicUser(account) };
}

/** 用导出的凭证码登录（换机器 / 重装之后用） */
async function loginWithVoucher(payload) {
  const voucher = normalizeVoucher((payload || {}).voucher);

  const state = loadState();
  const account = state.accounts.find((a) => a.voucher === voucher);
  if (!account) throw new Error('凭证码不对，检查一下有没有抄漏');

  state.session = {
    accountId: account.id,
    token: crypto.randomUUID(),
    at: new Date().toISOString()
  };
  await saveState(state);
  return { user: publicUser(account) };
}

async function logout() {
  const state = loadState();
  state.session = null;
  await saveState(state);
  return { user: null };
}

/**
 * 取登录凭证（没有就现生成一个，之后固定不变）。
 * 返回画卡片要的全部字段 —— 渲染层拿它画 PNG，主进程不碰画图。
 */
async function getVoucher() {
  const state = loadState();
  const account = currentAccount(state);
  if (!account) throw new Error('先登录再导出凭证');

  if (!account.voucher) {
    account.voucher = makeVoucher();
    await saveState(state);
  }
  return {
    code: account.voucher,
    username: account.username,
    email: account.email,
    avatar: account.avatar,
    createdAt: account.createdAt,
    version: ACCOUNT_VERSION
  };
}

/** 改资料（用户名 / 头像）；邮箱和密码各有自己的流程，见下面两个 */
async function updateProfile(payload) {
  const request = payload || {};
  const state = loadState();
  const account = currentAccount(state);
  if (!account) throw new Error('先登录');

  if (request.username != null) account.username = normalizeUsername(request.username);
  if (request.avatar != null) account.avatar = normalizeAvatar(request.avatar);

  await saveState(state);
  return { user: publicUser(account) };
}

/**
 * 改密码：要**当前密码**（防「人走了没锁屏，回来密码被换了」）。
 * 改完会话不踢：自己改的密码，没必要让自己重新登一遍。
 */
async function changePassword(payload) {
  const request = payload || {};
  const state = loadState();
  const account = currentAccount(state);
  if (!account) throw new Error('先登录');

  const current = String(request.currentPassword == null ? '' : request.currentPassword);
  if (hashPassword(current, account.salt) !== account.passwordHash) throw new Error('当前密码不对');

  const password = normalizePassword(request.password);
  const salt = crypto.randomBytes(16).toString('hex');
  account.salt = salt;
  account.passwordHash = hashPassword(password, salt);
  await saveState(state);
  return { user: publicUser(account) };
}

/**
 * 改邮箱：必须拿着**新邮箱**收到的验证码。
 * 码走的就是注册那条路（`sendEmailCode` 会先验图形码），所以这里只验码本身。
 * ⚠️ 真后端在这一步也该把旧邮箱发一封「邮箱已更换」的通知，不然号被盗了人都不知道。
 */
async function changeEmail(payload) {
  const request = payload || {};
  const email = normalizeEmail(request.email);
  const code = String(request.code || '').trim();

  const state = loadState();
  const account = currentAccount(state);
  if (!account) throw new Error('先登录');
  if (account.email === email) throw new Error('这就是你现在用的邮箱');
  if (state.accounts.some((a) => a.email === email)) throw new Error('这个邮箱已经被别的账号用了');

  const entry = emailCodes.get(email);
  if (!entry || entry.expiresAt < Date.now()) throw new Error('验证码过期了，重新获取');
  if (entry.tries >= CODE_MAX_TRIES) throw new Error('试错次数太多，重新获取验证码');
  if (code !== entry.code) {
    entry.tries += 1;
    throw new Error('验证码不对，再看看邮件');
  }
  emailCodes.delete(email);

  account.email = email;
  await saveState(state);
  return { user: publicUser(account) };
}

module.exports = {
  getSession,
  createCaptcha,
  sendEmailCode,
  register,
  completeProfile,
  login,
  loginWithVoucher,
  logout,
  getVoucher,
  updateProfile,
  changePassword,
  changeEmail
};
