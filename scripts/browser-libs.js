/* scripts/browser-libs.js
 *
 * 让 Playwright 的 Chromium 在无 root 的最小化容器（如 Debian 12 slim）里也能直接启动：
 *
 *  - ensureChromium()：npm postinstall 时调用，等价于 `playwright install chromium`，
 *    浏览器装在项目内 node_modules/.playwright（通过 PLAYWRIGHT_BROWSERS_PATH），
 *    不复用 ~/.cache 等会话临时目录。
 *  - prepareEnv()：窄屏测试启动浏览器前调用；用 `ldd` 找出可执行文件缺失的运行库，
 *    仅从与当前系统匹配的官方 Debian 仓库把对应 .deb 下载并解包到项目内
 *    node_modules/.chromium-libs（无需 root），返回带该目录的 LD_LIBRARY_PATH。
 *
 * 已经具备全部运行库的普通开发机上为空操作；非 Debian 系统无法自动补库时给出明确提示。
 */
'use strict';
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const BROWSERS_DIR = path.join(ROOT, 'node_modules', '.playwright');
const LIBS_DIR = path.join(ROOT, 'node_modules', '.chromium-libs');
const CACHE_DIR = path.join(LIBS_DIR, '.cache');

// Chromium 运行所需的 SONAME → Debian 包名（bookworm）
const SONAME_PACKAGE = {
  'libnspr4.so': 'libnspr4',
  'libnss3.so': 'libnss3',
  'libnssutil3.so': 'libnss3',
  'libsmime3.so': 'libnss3',
  'libatk-1.0.so.0': 'libatk1.0-0',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0',
  'libatspi.so.0': 'libatspi2.0-0',
  'libcups.so.2': 'libcups2',
  'libavahi-client.so.3': 'libavahi-client3',
  'libavahi-common.so.3': 'libavahi-common3',
  'libdrm.so.2': 'libdrm2',
  'libxkbcommon.so.0': 'libxkbcommon0',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1',
  'libXfixes.so.3': 'libxfixes3',
  'libXrandr.so.2': 'libxrandr2',
  'libXext.so.6': 'libxext6',
  'libX11.so.6': 'libx11-6',
  'libXrender.so.1': 'libxrender1',
  'libXi.so.6': 'libxi6',
  'libXtst.so.6': 'libxtst6',
  'libgbm.so.1': 'libgbm1',
  'libpango-1.0.so.0': 'libpango-1.0-0',
  'libcairo.so.2': 'libcairo2',
  'libasound.so.2': 'libasound2',
  'libdbus-1.so.3': 'libdbus-1-3',
  'libwayland-server.so.0': 'libwayland-server0',
  'libwayland-client.so.0': 'libwayland-client0',
  'libwayland-egl.so.1': 'libwayland-egl1',
  'libexpat.so.1': 'libexpat1',
  'libuuid.so.1': 'uuid-runtime',
  'libxcb.so.1': 'libxcb1',
  'libXau.so.6': 'libxau6',
  'libXdmcp.so.6': 'libxdmcp6'
};

function log(msg) { if (process.env.MRP_SETUP_QUIET !== '1') console.log('[browser-libs] ' + msg); }
function warn(msg) { console.warn('[browser-libs] ' + msg); }

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ---------- Playwright / Chromium 可执行文件 ----------

function playwrightRequire() {
  return require(require.resolve('playwright', { paths: [ROOT] }));
}

// 把浏览器装在项目目录内，避免依赖用户主目录缓存
function ensureBrowsersPathEnv() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;
}

function chromiumExecutables() {
  ensureBrowsersPathEnv();
  const { chromium } = playwrightRequire();
  const exe = chromium.executablePath();
  const exes = [exe];
  // 直接在浏览器安装根下找 headless shell
  try {
    const root = path.dirname(path.dirname(exe));
    fs.readdirSync(root).forEach(function (name) {
      if (name.startsWith('chromium_headless_shell-')) {
        const p = findBinary(path.join(root, name));
        if (p && !exes.includes(p)) exes.push(p);
      }
    });
  } catch (_) { /* ignore */ }
  return exes.filter(function (p) { try { return fs.existsSync(p); } catch (_) { return false; } });
}

function findBinary(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === 'chrome-headless-shell' || ent.name === 'headless_shell' ||
               (ent.name === 'chrome' && full.includes('chromium'))) return full;
    }
  }
  return null;
}

function ensureChromium() {
  ensureBrowsersPathEnv();
  mkdirp(BROWSERS_DIR);
  const cli = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('找不到 playwright/cli.js，请先 npm install');
  log('安装 Playwright Chromium 到项目目录（' + path.relative(ROOT, BROWSERS_DIR) + '）…');
  execFileSync(process.execPath, [cli, 'install', 'chromium'], {
    stdio: process.env.MRP_SETUP_QUIET === '1' ? 'ignore' : 'inherit',
    env: process.env
  });
}

// ---------- ldd 检测缺失运行库 ----------

function runLdd(exe, libPath) {
  let out = '';
  try {
    out = execSync('ldd "' + exe + '" 2>&1', {
      encoding: 'utf8',
      env: Object.assign({}, process.env, libPath ? { LD_LIBRARY_PATH: libPath } : {})
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  return out;
}

function missingLibs(exe, libPath) {
  const missing = new Set();
  runLdd(exe, libPath).split(/\r?\n/).forEach(function (line) {
    const m = /^\s*([^\s]+)\s+=>\s+not found/.exec(line);
    if (m) missing.add(m[1]);
  });
  return Array.from(missing);
}

// 迭代检测：补一批库后其自身依赖可能仍缺失（用上一轮目录辅助解析）
function allMissingLibs(exes) {
  const all = new Set();
  for (let pass = 0; pass < 4; pass++) {
    const libPath = vendorLibDirs().join(':') || '';
    let changed = false;
    exes.forEach(function (exe) {
      missingLibs(exe, libPath).forEach(function (soname) {
        if (!all.has(soname)) { all.add(soname); changed = true; }
      });
    });
    if (!changed) break;
  }
  return Array.from(all);
}

// ---------- 系统识别与 .deb 获取 ----------

function detectDebian() {
  let info = '';
  try { info = fs.readFileSync('/etc/os-release', 'utf8'); } catch (_) { return null; }
  const get = function (k) {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(info);
    return m ? m[1].replace(/"/g, '') : '';
  };
  const id = get('ID'), idLike = get('ID_LIKE');
  const isDebianLike = id === 'debian' || /debian/.test(idLike);
  if (!isDebianLike) return null;
  const codename = (get('VERSION_CODENAME') || (get('DEBIAN_CODENAME')) || 'bookworm');
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armhf', ia32: 'i386' };
  const arch = archMap[os.arch()] || os.arch();
  return {
    codename: codename,
    arch: arch,
    mirror: process.env.MRP_DEB_MIRROR || 'https://deb.debian.org/debian'
  };
}

function httpsGet(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'mrp-workbench-setup' } }, function (res) {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, url).href, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' ' + url)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}

// 下载并解析 Packages 索引，返回 packageName -> 相对 pool 路径
function packageIndex(sys) {
  mkdirp(CACHE_DIR);
  const idxFile = path.join(CACHE_DIR, 'Packages-' + sys.codename + '-' + sys.arch + '.txt');
  let text;
  if (fs.existsSync(idxFile)) {
    text = fs.readFileSync(idxFile, 'utf8');
  } else {
    const url = sys.mirror + '/dists/' + sys.codename + '/main/binary-' + sys.arch + '/Packages.xz';
    log('获取 Debian 包索引：' + url);
    const raw = httpsGetSync(url);
    text = zlib.xz ? zlib.xz.decompressSync(raw).toString('utf8')
                   : require('child_process').execFileSync('xz', ['-dc'], { input: raw, encoding: 'utf8', maxBuffer: 1024 * 1024 * 200 });
    fs.writeFileSync(idxFile, text);
  }
  const map = {};
  text.split('\n\n').forEach(function (para) {
    const nameM = /^Package: (.+)$/m.exec(para);
    const fileM = /^Filename: (.+)$/m.exec(para);
    if (nameM && fileM) map[nameM[1].trim()] = fileM[1].trim();
  });
  return map;
}

// httpsGet 的同步包装（postinstall 场景串行使用即可）
function httpsGetSync(url) {
  const tmp = path.join(CACHE_DIR, 'download-' + Math.random().toString(36).slice(2) + '.bin');
  try {
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'inherit'] });
    return fs.readFileSync(tmp);
  } catch (_) {
    throw new Error('下载失败：' + url);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

function downloadDeb(sys, relPath) {
  const dest = path.join(CACHE_DIR, path.basename(relPath));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  mkdirp(CACHE_DIR);
  log('下载运行库包：' + relPath);
  const url = sys.mirror.replace(/\/$/, '') + '/' + relPath;
  const buf = httpsGetSync(url);
  fs.writeFileSync(dest, buf);
  return dest;
}

function extractDeb(debFile) {
  mkdirp(LIBS_DIR);
  try {
    execFileSync('dpkg-deb', ['-x', debFile, LIBS_DIR], { stdio: 'ignore' });
    return;
  } catch (_) {
    // 回退：ar x data.tar.* → tar
    const stage = path.join(CACHE_DIR, 'extract-' + path.basename(debFile));
    mkdirp(stage);
    execFileSync('ar', ['x', debFile], { cwd: stage, stdio: 'ignore' });
    const dataTar = fs.readdirSync(stage).find(function (f) { return /^data\.tar\./.test(f); });
    if (!dataTar) throw new Error('无法解包 ' + debFile + '（缺少 data.tar）');
    execFileSync('tar', ['-xf', path.join(stage, dataTar), '-C', LIBS_DIR], { stdio: 'ignore' });
  }
}

function vendorLibDirs() {
  const dirs = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    let hasSo = false;
    entries.forEach(function (ent) {
      if (ent.isDirectory()) {
        if (ent.name === '.cache') return;
        walk(path.join(d, ent.name));
      } else if (/\.so(\.|$)/.test(ent.name)) hasSo = true;
    });
    if (hasSo) dirs.push(d);
  })(LIBS_DIR);
  return dirs;
}

// ---------- 对外主入口 ----------

// 供测试调用：返回包含项目内置运行库的环境变量对象
function prepareEnv() {
  ensureBrowsersPathEnv();
  const exes = chromiumExecutables();
  if (!exes.length) {
    // 浏览器尚未安装（postinstall 未跑过，如 npm install --ignore-scripts）
    ensureChromium();
  }
  const sys = detectDebian();
  // 下载 → 解包 → 重新检测，循环直到无缺失（新解包的库可能还带着缺失依赖）
  for (let round = 0; round < 5; round++) {
    const missing = exes.length ? allMissingLibs(exes) : [];
    if (!missing.length) break;
    if (!sys) {
      throw new Error(
        'Chromium 缺少运行库：' + missing.join(', ') + '。当前系统不是 Debian 系，\n' +
        '请用系统包管理器安装浏览器依赖（Ubuntu/Debian 可执行：npx playwright install-deps chromium）。');
    }
    const idx = packageIndex(sys);
    const wanted = [];
    const seenPkg = new Set();
    missing.forEach(function (soname) {
      const pkg = SONAME_PACKAGE[soname];
      if (!pkg) throw new Error('未知运行库 ' + soname + '，请在 scripts/browser-libs.js 的 SONAME_PACKAGE 中补充其 Debian 包名。');
      if (!seenPkg.has(pkg)) { seenPkg.add(pkg); wanted.push(pkg); }
    });
    let extractedAny = false;
    wanted.forEach(function (pkg) {
      const marker = path.join(LIBS_DIR, '.pkg-' + pkg);
      if (fs.existsSync(marker)) return;
      const rel = idx[pkg];
      if (!rel) throw new Error('Debian ' + sys.codename + '/' + sys.arch + ' 仓库中找不到包 ' + pkg);
      extractDeb(downloadDeb(sys, rel));
      fs.writeFileSync(marker, rel);
      extractedAny = true;
    });
    if (!extractedAny) break;
  }
  const dirs = vendorLibDirs();
  const env = Object.assign({}, process.env);
  env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;
  if (dirs.length) env.LD_LIBRARY_PATH = dirs.join(':') + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  return env;
}

// postinstall：装浏览器 + 预取运行库（失败不阻断 npm install，只警告，首次跑测试会重试）
function postinstall() {
  try {
    ensureChromium();
    const env = prepareEnv();
    if (env.LD_LIBRARY_PATH) {
      log('运行库已内置到 ' + path.relative(ROOT, LIBS_DIR) + '，测试将自动加载，无需设置环境变量。');
    } else {
      log('系统已具备 Chromium 全部运行库，无需额外下载。');
    }
  } catch (e) {
    warn('postinstall 预装 Chromium/运行库未完成：' + e.message);
    warn('可稍后重跑 `node scripts/browser-libs.js`，或运行 `npm run test:mobile` 时自动重试。');
  }
}

if (require.main === module) postinstall();

module.exports = { prepareEnv: prepareEnv, postinstall: postinstall, BROWSERS_DIR: BROWSERS_DIR };
