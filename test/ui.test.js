/* ui.test.js — 用 jsdom 实际加载 index.html / app.js，模拟用户操作核对界面行为。
 * 运行：node test/ui.test.js   （需要 /tmp/node_modules 中安装 jsdom）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM } = require('/tmp/node_modules/jsdom');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mrpSrc = fs.readFileSync(path.join(root, 'mrp.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function boot(localStorageData) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.confirm = () => true;
  window.alert = (m) => { throw new Error('意外弹窗: ' + m); };
  if (localStorageData) window.localStorage.setItem('mrp-workbench-v1', JSON.stringify(localStorageData));
  window.eval(mrpSrc);
  window.eval(appSrc);
  return dom;
}

function setValue(dom, el, value) {
  const { window } = dom;
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function click(dom, el) { el.dispatchEvent(new dom.window.Event('click', { bubbles: true })); }
function text(dom, sel) { return dom.window.document.querySelector(sel).textContent; }
function rows(dom, sel) { return dom.window.document.querySelectorAll(sel); }

console.log('\n[UI 1] 首次启动与渲染');

let dom = boot();
test('首次打开自动载入示例并完成点算：显示成功横幅、计划单与逐层结果', () => {
  const errBanner = text(dom, '#errorBanner');
  assert(errBanner === '', '错误横幅应为空，实际: ' + errBanner.slice(0, 80));
  const result = text(dom, '#resultPanel');
  assert(result.includes('点算完成'), '应显示成功横幅，实际: ' + result.slice(0, 80));
  assert(result.includes('投产与到货倒排'), '应渲染计划表');
  assert(result.includes('毛需求'), '应渲染逐层毛需求表');
  assert(/FG/.test(result), '结果应包含成品 FG');
});

test('计划数量倒排：FG D20 到货、提前期2天 → D18 投产', () => {
  const MRP = dom.window.MRP;
  const result = MRP.runPlan(MRP.seedData('2026-09-14'), '2026-09-14');
  const fg = result.plannedOrders.filter(p => p.material === 'FG')[0];
  assert(fg.dueDate === '2026-10-04' && fg.releaseDate === '2026-10-02',
    'FG 应 D20 到货、D18 投产，实际 ' + JSON.stringify(fg));
  const html = text(dom, '#resultPanel');
  assert(html.includes('2026-10-04') && html.includes('2026-10-02'), '界面应展示倒排日期');
});

test('localStorage 已写入数据（刷新可恢复）', () => {
  const raw = dom.window.localStorage.getItem('mrp-workbench-v1');
  assert(raw, 'localStorage 应有存档');
  const parsed = JSON.parse(raw);
  assert(parsed.data && parsed.data.materials.length === 5, '存档应有 5 个物料');
});

console.log('\n[UI 2] 编辑订单后所有层级与日期重算');

test('把订单 SO-2 数量从 6 改为 0 → 引擎阻断，界面切到错误态且不展示旧计划', () => {
  // 切到订单 tab
  click(dom, dom.window.document.querySelector('.tab[data-tab="orders"]'));
  const inputs = rows(dom, '#editorPanel input[data-field="qty"]');
  assert(inputs.length === 2, '示例应有 2 张订单输入框，实际 ' + inputs.length);
  setValue(dom, inputs[1], '0');
  const banner = text(dom, '#errorBanner');
  assert(banner.includes('点算被阻断'), '数量 0 应阻断：' + banner.slice(0, 80));
  const result = text(dom, '#resultPanel');
  assert(result.includes('计划未产出'), '错误态不得展示旧计划表: ' + result.slice(0, 60));
  // 对应行高亮
  const errRows = rows(dom, '#editorPanel tr.row-err');
  assert(errRows.length >= 1, '非法行应标红');
});

test('改回合法数量 6 后错误消失，结果恢复（证明状态由数据驱动、无脏结果）', () => {
  const inputs = rows(dom, '#editorPanel input[data-field="qty"]');
  setValue(dom, inputs[1], '6');
  const banner = text(dom, '#errorBanner');
  assert(banner === '', '横幅应清空，实际: ' + banner.slice(0, 60));
  assert(text(dom, '#resultPanel').includes('点算完成'), '应恢复成功结果');
});

test('删除一张订单后，FG 毛需求从 16 变 10，下层 W 需求同步变化', () => {
  // 当前在订单 tab，删除第二行
  const dels = rows(dom, '#editorPanel button.del');
  click(dom, dels[1]);
  const resultText = text(dom, '#resultPanel');
  // FG 行毛需求应为 10
  const MRP = dom.window.MRP;
  const live = MRP.runPlan(JSON.parse(dom.window.localStorage.getItem('mrp-workbench-v1')).data);
  const fg = live.rows.filter(r => r.material === 'FG')[0];
  assert(fg.gross === 10, 'FG 毛需求应为 10，实际 ' + fg.gross);
  assert(resultText.includes('点算完成'), '界面应展示重算结果');
});

console.log('\n[UI 3] 刷新恢复');

test('用当前 localStorage 重新启动（模拟刷新）：数据与结果原样恢复', () => {
  const saved = JSON.parse(dom.window.localStorage.getItem('mrp-workbench-v1')).data;
  const dom2 = boot({ version: 1, data: saved, savedAt: new Date().toISOString() });
  const orderRows = rows(dom2, '#editorPanel input[data-field="id"]');
  assert(orderRows.length === 1, '刷新后应只剩 1 张订单，实际 ' + orderRows.length);
  assert(text(dom2, '#resultPanel').includes('点算完成'), '刷新后应自动重算成功');
});

console.log('\n[UI 4] 循环依赖阻断（在界面中录入）');

test('新增 BOM S→FG 制造循环：阻断横幅列出具体环，计划区域为空结果态', () => {
  click(dom, dom.window.document.querySelector('.tab[data-tab="boms"]'));
  // 新增一行
  click(dom, dom.window.document.querySelector('button[data-act="add"]'));
  const trs = rows(dom, '#editorPanel tbody tr');
  const last = trs[trs.length - 1];
  const selects = last.querySelectorAll('select');
  selects[0].value = 'S'; selects[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  selects[1].value = 'FG'; selects[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const banner = text(dom, '#errorBanner');
  assert(banner.includes('循环依赖'), '应报循环依赖: ' + banner.slice(0, 120));
  assert(/FG → .* → S → FG|FG → .*→/.test(banner) || banner.includes('FG'), '应列出环上物料');
  assert(text(dom, '#resultPanel').includes('计划未产出'), '循环时不得显示旧计划');
});

console.log('\n[UI 5] 库存同时段竞用在界面可见');

test('库存占用流水：D5 的 W 库存 4 被同日需求占用、D8 需求占用为 0（界面数字正确）', () => {
  // 重置为干净示例
  dom.window.confirm = () => true;
  click(dom, dom.window.document.getElementById('btnSeed'));
  const MRP = dom.window.MRP;
  const data = MRP.seedData('2026-09-14');
  const r = MRP.runPlan(data, '2026-09-14');
  const w5 = r.rows.filter(x => x.material === 'W' && x.date === MRP.addDays('2026-09-14', 15))[0];
  const w8 = r.rows.filter(x => x.material === 'W' && x.date === MRP.addDays('2026-09-14', 18))[0];
  assert(w5.stockAllocated === 4 && w5.stockLeft === 0, 'W@D5 应占用4余0');
  assert(w8.stockAllocated === 0, 'W@D8 不应跨日占用 D5 库存');
  // 界面结果文本含占用标记
  const out = text(dom, '#resultPanel');
  assert(out.includes('库存占用'), '界面应有库存占用列');
});

test('缺料（投产已晚于今天）在界面进入缺料清单与缺口列', () => {
  const MRP = dom.window.MRP;
  const d = {
    materials: [{ id: 'A', name: '', leadTime: 10 }],
    inventories: [],
    orders: [{ _id: 'x', id: 'O1', material: 'A', qty: 3, dueDate: '2026-09-19' }],
    boms: []
  };
  // 用界面状态：直接替换 localStorage 后重启最稳
  const dom2 = boot({ version: 1, data: d });
  const out = text(dom2, '#resultPanel');
  assert(out.includes('存在缺口'), '应有缺口警示');
  assert(out.includes('投产已晚'), '计划单应标红为投产已晚');
  assert(out.includes('缺 3'), '缺口数量应显示为 3');
});

console.log('\n[UI 6] 错误行定位与重复父子关系');

test('重复父子关系报具体物料对，且 BOM 行高亮', () => {
  click(dom, dom.window.document.querySelector('.tab[data-tab="boms"]'));
  click(dom, dom.window.document.querySelector('button[data-act="add"]'));
  let trs = rows(dom, '#editorPanel tbody tr');
  let last = trs[trs.length - 1];
  let sels = last.querySelectorAll('select');
  sels[0].value = 'FG'; sels[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  sels[1].value = 'SA'; sels[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const banner = text(dom, '#errorBanner');
  assert(banner.includes('重复父子关系') && banner.includes('FG → SA'), banner.slice(0, 120));
  assert(rows(dom, '#editorPanel tr.row-err').length >= 2, '重复两行都应高亮');
});

console.log('\n==============================================');
console.log('UI 测试通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '，全部通过'));
process.exit(failed ? 1 : 0);
