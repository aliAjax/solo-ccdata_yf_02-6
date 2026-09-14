/* mobile.test.js — Playwright 真浏览器核对：
 *  1) 375px 窄屏下四个维护页与结果区均无横向页面溢出（宽表只在容器内滚动）；
 *  2) 窄屏下可正常编辑，且非法数量只高亮出错那一行，同物料/同页的其它行不被标红；
 *  3) 1280px 桌面端仍无溢出、结果正常。
 * 依赖：npm install（playwright）+ npx playwright install chromium
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
// prepareEnv 会把 Chromium 缺失的运行库自动补到项目内并配置好路径，
// 因此在最小化容器中也可直接启动浏览器，无需手工设置 LD_LIBRARY_PATH。
const browserEnv = require('../scripts/browser-libs').prepareEnv();
Object.assign(process.env, browserEnv);
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.normalize(path.join(root, urlPath));
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message.split('\n').slice(0, 3).join('\n      ')); }
}
function check(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const srv = await startServer();
  const base = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const browser = await chromium.launch();

  console.log('\n[窄屏 375×812] 横向溢出与可编辑性');
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#resultPanel').textContent.length > 0);

  const overflow = async () => page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyW: document.body.scrollWidth
  }));

  await test('首屏无页面级横向滚动', async () => {
    const o = await overflow();
    check(o.scrollW <= o.clientW, `scrollWidth=${o.scrollW} > clientWidth=${o.clientW}（body=${o.bodyW}）`);
  });

  await test('结果区宽表只在自己容器内滚动，不撑破页面', async () => {
    const info = await page.evaluate(() => {
      const wide = document.querySelector('#resultPanel .scroll table');
      const wrap = wide.closest('.scroll');
      return { tableW: wide.scrollWidth, wrapClient: wrap.clientWidth, wrapScroll: wrap.scrollWidth };
    });
    check(info.tableW > info.wrapClient, '示例结果表应比容器宽（确实需要内部滚动）');
    const o = await overflow();
    check(o.scrollW <= o.clientW, '结果表把页面撑宽了：' + JSON.stringify(o));
  });

  for (const tab of ['orders', 'materials', 'inventories', 'boms']) {
    await test('切到「' + tab + '」页无横向溢出', async () => {
      await page.click('.tab[data-tab="' + tab + '"]');
      await page.waitForTimeout(50);
      const o = await overflow();
      check(o.scrollW <= o.clientW, tab + ': scrollWidth=' + o.scrollW + ' > ' + o.clientW);
    });
  }

  await test('窄屏下点算按钮与新增行按钮可点击', async () => {
    await page.click('button[data-act="add"][data-kind="boms"]');
    const count = await page.locator('#editorPanel tbody tr').count();
    check(count === 7, '新增后 BOM 应有 7 行，实际 ' + count);
  });

  console.log('\n[窄屏] 错误只高亮出错那一行');

  await test('库存页：只把 W 那行数量改成 -1，同页 B 行保持不红，且仅 1 行高亮', async () => {
    await page.click('.tab[data-tab="inventories"]');
    const rows = page.locator('#editorPanel tbody tr');
    const n = await rows.count();
    let wRow = null;
    for (let i = 0; i < n; i++) {
      const mat = await rows.nth(i).locator('select').inputValue();
      if (mat === 'W') wRow = i;
    }
    check(wRow !== null, '找不到 W 库存行');
    const qty = rows.nth(wRow).locator('input[data-field="qty"]');
    await qty.fill('-1');
    await page.waitForTimeout(60);
    const badCount = await page.locator('#editorPanel tbody tr.row-err').count();
    check(badCount === 1, '应仅 1 行标红，实际 ' + badCount);
    const badMat = await page.locator('#editorPanel tbody tr.row-err select').first().inputValue();
    check(badMat === 'W', '被标红的应是 W 行，实际是 ' + badMat);
    // 横幅中点名库存表的具体行号
    const banner = await page.locator('#errorBanner').innerText();
    check(/库存表第\s*\d+\s*行/.test(banner), '横幅应指出库存表具体行：' + banner.slice(0, 100));
    // 改回合法值后红行消失
    await qty.fill('4');
    await page.waitForTimeout(60);
    check(await page.locator('#editorPanel tbody tr.row-err').count() === 0, '修正后不应再有红行');
  });

  await test('订单页：只把第一张订单数量改 0，第二张订单不被标红', async () => {
    await page.click('.tab[data-tab="orders"]');
    const q0 = page.locator('#editorPanel tbody tr').nth(0).locator('input[data-field="qty"]');
    await q0.fill('0');
    await page.waitForTimeout(60);
    check(await page.locator('#editorPanel tbody tr.row-err').count() === 1, '应只有非法的那一张订单标红');
    check(await page.locator('#editorPanel tbody tr').nth(1).evaluate(el => !el.classList.contains('row-err')),
      '第二张有效订单不应标红');
    await q0.fill('10');
    await page.waitForTimeout(60);
  });

  await test('重复父子关系：两行 FG→SA 同时高亮，其它 BOM 行不红', async () => {
    await page.click('.tab[data-tab="boms"]');
    // 之前新增的第 7 行仍为空（可能已标红），把它设成 FG→SA 制造重复
    const last = page.locator('#editorPanel tbody tr').nth(6);
    await last.locator('select[data-field="parent"]').selectOption('FG');
    await last.locator('select[data-field="child"]').selectOption('SA');
    await page.waitForTimeout(60);
    const badRows = await page.locator('#editorPanel tbody tr.row-err').evaluateAll(
      els => els.map(el => Array.from(el.querySelectorAll('select')).map(s => s.value).join('→')));
    check(badRows.length === 2, 'FG→SA 两行应标红，实际 ' + badRows.length + ' 行：' + JSON.stringify(badRows));
    check(badRows.every(x => x === 'FG→SA'), '标红行应为两条 FG→SA，实际 ' + JSON.stringify(badRows));
    const banner = await page.locator('#errorBanner').innerText();
    check(banner.includes('重复父子关系'), '应阻断并说明重复父子关系');
  });

  await test('窄屏下无脚本运行错误', async () => {
    check(pageErrors.length === 0, '页面错误：' + pageErrors.join(' | '));
  });

  await ctx.close();

  console.log('\n[桌面 1280×900] 回归');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(base, { waitUntil: 'load' });
  await page2.waitForFunction(() => document.querySelector('#resultPanel').textContent.length > 0);
  await test('桌面端无横向溢出，双栏布局与点算结果正常', async () => {
    const o = await page2.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth
    }));
    check(o.scrollW <= o.clientW, '桌面端溢出 ' + JSON.stringify(o));
    check(await page2.locator('#resultPanel').innerText().then(t => t.includes('点算完成')), '应显示成功结果');
    check(await page2.locator('.banner.err').count() === 0, '示例数据不应有错误横幅');
  });
  await ctx2.close();

  await browser.close();
  srv.close();

  console.log('\n==============================================');
  console.log('窄屏/桌面测试通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '，全部通过'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
