/*
 * mrp.test.js — Node 场景核对（无第三方依赖）：node test/mrp.test.js
 * 覆盖：多层共用件展开 / 库存同时段竞用 / 跨时段不可占用 / 循环依赖阻断 /
 *       缺料与非法数量 / 重复父子 / 提前期倒排 / 保存恢复 / 改单后无旧结果残留。
 */
'use strict';
const assert = require('assert');
const MRP = require('../mrp.js');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push([name, e]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const TODAY = '2026-09-14';
function days(n) { return MRP.addDays(TODAY, n); }

function baseData() {
  return {
    materials: [
      { id: 'FG', name: '成品', leadTime: 2 },
      { id: 'SA', name: '组件', leadTime: 3 },
      { id: 'W', name: '共用件W', leadTime: 4 },
      { id: 'B', name: '共用件B', leadTime: 1 },
      { id: 'S', name: '原料', leadTime: 5 }
    ],
    inventories: [
      { material: 'B', qty: 50, date: days(5) },
      { material: 'W', qty: 4, date: days(5) }
    ],
    orders: [
      { id: 'SO-1', material: 'FG', qty: 10, dueDate: days(10) },
      { id: 'SO-2', material: 'FG', qty: 6, dueDate: days(10) }
    ],
    boms: [
      { parent: 'FG', child: 'SA', qtyPer: 1, scrapRate: 0 },
      { parent: 'FG', child: 'W', qtyPer: 2, scrapRate: 0 },
      { parent: 'SA', child: 'W', qtyPer: 2, scrapRate: 0.05 },
      { parent: 'SA', child: 'B', qtyPer: 4, scrapRate: 0 },
      { parent: 'W', child: 'B', qtyPer: 2, scrapRate: 0 },
      { parent: 'W', child: 'S', qtyPer: 3, scrapRate: 0.1 }
    ]
  };
}

function rowAt(result, material, date) {
  const r = result.rows.filter(r => r.material === material && r.date === date);
  assert.strictEqual(r.length, 1, '应恰好有一行 ' + material + '@' + date);
  return r[0];
}
function posOf(result, material) {
  return result.plannedOrders.filter(p => p.material === material);
}

console.log('\n[1] 多层共用件：毛需求 / 净需求 / 逐层展开');

test('成品 FG 两订单同日合并：毛需求 16，计划单倒排到货=需求日、投产=到货-LT', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  assert.strictEqual(r.ok, true);
  const fg = rowAt(r, 'FG', days(10));
  assert.strictEqual(fg.gross, 16);
  assert.strictEqual(fg.net, 16);
  assert.strictEqual(fg.stockAllocated, 0);
  const po = posOf(r, 'FG');
  assert.strictEqual(po.length, 1);
  assert.strictEqual(po[0].qty, 16);
  assert.strictEqual(po[0].dueDate, days(10));       // 到货日期
  assert.strictEqual(po[0].releaseDate, days(8));    // 提前期 2
});

test('共用件 W 同时被 FG（2/FG）和 SA（2/SA，含5%损耗）引用，需求在同一投产日合并', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  // FG 投产日 = D8；SA 需求 16 在 D8，SA 提前期 3 → SA 投产 D5，W 因 SA 产生的需求在 D5
  const w5 = rowAt(r, 'W', days(5));
  // SA×16，2 个/件，损耗 5% → 16*2/0.95 = 33.684… 向上取整前的毛需求
  assert.ok(Math.abs(w5.gross - 16 * 2 / 0.95) < 1e-6, 'W@D5 毛需求=' + w5.gross);
  const w8 = rowAt(r, 'W', days(8));
  assert.strictEqual(w8.gross, 32); // FG×16 × 2
});

test('W@D5 库存 4 只能占用同一天需求，净需求向上取整生成一张计划单', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  const w5 = rowAt(r, 'W', days(5));
  assert.strictEqual(w5.initialStock, 4);
  assert.strictEqual(w5.stockAllocated, 4);
  assert.strictEqual(w5.stockLeft, 0);
  const expectedNet = 16 * 2 / 0.95 - 4;
  assert.ok(Math.abs(w5.net - expectedNet) < 1e-6);
  assert.strictEqual(w5.net > 0, true);
  const po = posOf(r, 'W').find(p => p.needDate === days(5));
  assert.ok(po, 'W@D5 应有计划单');
  assert.strictEqual(po.qty, Math.ceil(expectedNet));
  assert.strictEqual(po.releaseDate, days(1)); // LT=4
});

test('W@D8 需求 32 不得挪用 D5 的库存：库存占用必须为 0', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  const w8 = rowAt(r, 'W', days(8));
  assert.strictEqual(w8.stockAllocated, 0);
  assert.strictEqual(w8.net, 32);
});

test('共用件 B 的需求汇聚到同一投产日并按日竞用库存 50', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  // SA 投产 D5 → B 毛需求 16*4=64 @D5
  // W@D5 计划单 ceil(33.684-4)=30 件投产 D1 → B 需求 60 @D1
  // W@D8 计划单 32 件投产 D4 → B 需求 64 @D4
  const b5 = rowAt(r, 'B', days(5));
  assert.strictEqual(b5.gross, 64);
  assert.strictEqual(b5.stockAllocated, 50);
  assert.strictEqual(b5.net, 14);
  const b1 = rowAt(r, 'B', days(1));
  assert.strictEqual(b1.stockAllocated, 0, 'D1 需求不可用 D5 库存');
  const b4 = rowAt(r, 'B', days(4));
  assert.strictEqual(b4.stockAllocated, 0, 'D4 需求不可用 D5 库存');
});

test('最底层原料 S 按 W 计划单数 × 有效用量（损耗10%）展开', () => {
  const r = MRP.runPlan(baseData(), TODAY);
  const w5po = posOf(r, 'W').find(p => p.needDate === days(5));
  const w8po = posOf(r, 'W').find(p => p.needDate === days(8));
  const s1 = rowAt(r, 'S', days(1));
  assert.ok(Math.abs(s1.gross - w5po.qty * 3 / 0.9) < 1e-6, 'S@D1=' + s1.gross);
  const s4 = rowAt(r, 'S', days(4));
  assert.ok(Math.abs(s4.gross - w8po.qty * 3 / 0.9) < 1e-6, 'S@D4=' + s4.gross);
});

console.log('\n[2] 库存同时段竞用');

test('同一天多张订单按产生顺序瓜分当日库存，先到者占用、后者转净需求', () => {
  const d = {
    materials: [{ id: 'X', leadTime: 2 }, { id: 'P', leadTime: 1 }],
    inventories: [{ material: 'X', qty: 10, date: days(6) }],
    orders: [
      { id: 'O1', material: 'X', qty: 7, dueDate: days(6) },
      { id: 'O2', material: 'X', qty: 8, dueDate: days(6) }
    ],
    boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, true);
  const x = rowAt(r, 'X', days(6));
  assert.strictEqual(x.gross, 15);
  assert.strictEqual(x.stockAllocated, 10);
  assert.strictEqual(x.net, 5);
  assert.strictEqual(x.stockLeft, 0);
  // 占用流水体现顺序：第一笔需求占 7，第二笔占剩余 3
  assert.strictEqual(r.allocations.length, 2);
  assert.strictEqual(r.allocations[0].qty, 7);
  assert.strictEqual(r.allocations[1].qty, 3);
});

test('库存放在另一日期时完全不可被需求占用（跨时段隔离）', () => {
  const d = {
    materials: [{ id: 'X', leadTime: 0 }],
    inventories: [{ material: 'X', qty: 100, date: days(7) }],
    orders: [{ id: 'O1', material: 'X', qty: 5, dueDate: days(6) }],
    boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  const x6 = rowAt(r, 'X', days(6));
  assert.strictEqual(x6.stockAllocated, 0);
  assert.strictEqual(x6.net, 5);
});

test('当日库存充足时净需求为 0，不产生计划单，也不向下层展开', () => {
  const d = {
    materials: [{ id: 'X', leadTime: 1 }, { id: 'C', leadTime: 1 }],
    inventories: [{ material: 'X', qty: 5, date: days(3) }],
    orders: [{ id: 'O1', material: 'X', qty: 5, dueDate: days(3) }],
    boms: [{ parent: 'X', child: 'C', qtyPer: 10, scrapRate: 0 }]
  };
  const r = MRP.runPlan(d, TODAY);
  const x = rowAt(r, 'X', days(3));
  assert.strictEqual(x.net, 0);
  assert.strictEqual(posOf(r, 'X').length, 0);
  assert.strictEqual(r.rows.some(x => x.material === 'C'), false, '被库存完全覆盖时不应展开 C');
});

console.log('\n[3] 错误阻断：缺料 / 非法数量 / 重复父子 / 循环依赖');

test('循环依赖列出具体物料与环路径，且不产出任何计划', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }, { id: 'B', leadTime: 1 }, { id: 'C', leadTime: 1 }],
    inventories: [],
    orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }],
    boms: [
      { parent: 'A', child: 'B', qtyPer: 1, scrapRate: 0 },
      { parent: 'B', child: 'C', qtyPer: 1, scrapRate: 0 },
      { parent: 'C', child: 'A', qtyPer: 1, scrapRate: 0 }
    ]
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  const cyc = r.errors.filter(e => e.code === 'CYCLE');
  assert.strictEqual(cyc.length, 1);
  assert.ok(/A → B → C → A/.test(cyc[0].message), cyc[0].message);
  assert.strictEqual(cyc[0].material, 'A');
  assert.strictEqual(r.plannedOrders.length, 0);
  assert.strictEqual(r.rows.length, 0);
});

test('自循环 A→A 被识别为循环依赖', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }], inventories: [],
    orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }],
    boms: [{ parent: 'A', child: 'A', qtyPer: 1, scrapRate: 0 }]
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'CYCLE' && e.material === 'A'));
});

test('缺料：BOM/库存/订单引用不存在的物料时逐一列出具体编码', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }],
    inventories: [{ material: 'GHOST1', qty: 2, date: days(1) }],
    orders: [{ id: 'O1', material: 'GHOST2', qty: 1, dueDate: days(5) }],
    boms: [{ parent: 'A', child: 'GHOST3', qtyPer: 1, scrapRate: 0 }]
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  const missing = r.errors.filter(e => e.code === 'MISSING_MATERIAL').map(e => e.material).sort();
  assert.deepStrictEqual(missing, ['GHOST1', 'GHOST2', 'GHOST3']);
});

test('非法数量：0、负数、非数字被逐行列出具体物料', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }, { id: 'B', leadTime: 1 }],
    inventories: [{ material: 'A', qty: -3, date: days(1) }],
    orders: [{ id: 'O1', material: 'A', qty: 0, dueDate: days(5) }],
    boms: [
      { parent: 'A', child: 'B', qtyPer: 'x', scrapRate: 0 },
      { parent: 'A', child: 'B', qtyPer: 1, scrapRate: 1.2 }
    ]
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'INVALID_QTY' && e.material === 'A'));
  assert.ok(r.errors.some(e => e.code === 'INVALID_QTY' && e.material === 'B'));
  assert.ok(r.errors.some(e => e.code === 'INVALID_SCRAP' && e.material === 'B'));
});

test('非法提前期（负数 / 小数）被阻断并指明物料', () => {
  const d = {
    materials: [{ id: 'A', leadTime: -1 }, { id: 'B', leadTime: 2.5 }],
    inventories: [], orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }], boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  const lt = r.errors.filter(e => e.code === 'INVALID_LEAD_TIME').map(e => e.material).sort();
  assert.deepStrictEqual(lt, ['A', 'B']);
});

test('重复父子关系 A→B 被阻断并指出是哪一对', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }, { id: 'B', leadTime: 1 }],
    inventories: [], orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }],
    boms: [
      { parent: 'A', child: 'B', qtyPer: 1, scrapRate: 0 },
      { parent: 'A', child: 'B', qtyPer: 2, scrapRate: 0 }
    ]
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  const dup = r.errors.filter(e => e.code === 'DUPLICATE_BOM');
  assert.strictEqual(dup.length, 1);
  assert.ok(/A → B/.test(dup[0].message));
});

test('非法日期被阻断', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }],
    inventories: [{ material: 'A', qty: 1, date: '2026-13-40' }],
    orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: 'not-a-date' }], boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'INVALID_DATE'));
});

test('targets 精确到行：同物料两条库存/订单，只有非法那一行被定位', () => {
  const d = {
    materials: [{ id: 'X', leadTime: 1 }],
    inventories: [
      { material: 'X', qty: 10, date: days(1) },   // 合法
      { material: 'X', qty: -2, date: days(1) }    // 非法
    ],
    orders: [
      { id: 'O1', material: 'X', qty: 5, dueDate: days(3) },  // 合法
      { id: 'O2', material: 'X', qty: 0, dueDate: days(3) }   // 非法
    ],
    boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  const invErr = r.errors.filter(e => e.code === 'INVALID_QTY' && e.targets[0].kind === 'inventories');
  assert.strictEqual(invErr.length, 1);
  assert.strictEqual(invErr[0].targets[0].index, 1, '应只指向库存第 2 行');
  const ordErr = r.errors.filter(e => e.code === 'INVALID_QTY' && e.targets[0].kind === 'orders');
  assert.strictEqual(ordErr.length, 1);
  assert.strictEqual(ordErr[0].targets[0].index, 1, '应只指向订单第 2 行');
});

test('targets 精确到行：重复父子只标这两行，循环依赖只标环上的边', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 1 }, { id: 'B', leadTime: 1 }, { id: 'C', leadTime: 1 }],
    inventories: [],
    orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }],
    boms: [
      { parent: 'A', child: 'B', qtyPer: 1, scrapRate: 0 },
      { parent: 'B', child: 'C', qtyPer: 1, scrapRate: 0 },
      { parent: 'C', child: 'A', qtyPer: 1, scrapRate: 0 }
    ]
  };
  let r = MRP.runPlan(d, TODAY);
  const cyc = r.errors.filter(e => e.code === 'CYCLE');
  assert.strictEqual(cyc.length, 1);
  assert.deepStrictEqual(cyc[0].targets.map(t => t.index).sort(), [0, 1, 2]);
  // 再加一条重复边（此时环存在也会报；单独验证 DUPLICATE_BOM 的 targets）
  const d2 = {
    materials: [{ id: 'A', leadTime: 1 }, { id: 'B', leadTime: 1 }],
    inventories: [], orders: [{ id: 'O1', material: 'A', qty: 1, dueDate: days(5) }],
    boms: [
      { parent: 'A', child: 'B', qtyPer: 1, scrapRate: 0 },
      { parent: 'A', child: 'B', qtyPer: 2, scrapRate: 0 }
    ]
  };
  r = MRP.runPlan(d2, TODAY);
  const dup = r.errors.filter(e => e.code === 'DUPLICATE_BOM');
  assert.strictEqual(dup.length, 1);
  assert.deepStrictEqual(dup[0].targets.map(t => t.index), [0, 1]);
});

console.log('\n[4] 排期与缺口');

test('投产日期晚于今天的件不算缺口；倒排后必须今天前投产的件进入缺料清单', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 10 }],
    inventories: [],
    orders: [{ id: 'O1', material: 'A', qty: 3, dueDate: days(5) }], boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shortages.length, 1);
  assert.strictEqual(r.shortages[0].material, 'A');
  assert.strictEqual(r.shortages[0].qty, 3);
  const x = rowAt(r, 'A', days(5));
  assert.strictEqual(x.shortage, 3);
});

test('提前期 0 时投产日期等于到货日期', () => {
  const d = {
    materials: [{ id: 'A', leadTime: 0 }], inventories: [],
    orders: [{ id: 'O1', material: 'A', qty: 2, dueDate: days(0) }], boms: []
  };
  const r = MRP.runPlan(d, TODAY);
  const po = posOf(r, 'A')[0];
  assert.strictEqual(po.releaseDate, TODAY);
  assert.strictEqual(po.dueDate, TODAY);
});

console.log('\n[5] 保存 / 恢复 / 无旧结果残留');

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}

test('数据可写入浏览器式本地存储并原样恢复（刷新场景）', () => {
  const s = memStorage();
  const d = baseData();
  MRP.saveData(d, s);
  const back = MRP.loadData(s);
  assert.deepStrictEqual(back, d);
});

test('空存储 loadData 返回 null；clearData 后再读为 null', () => {
  const s = memStorage();
  assert.strictEqual(MRP.loadData(s), null);
  MRP.saveData(baseData(), s);
  MRP.clearData(s);
  assert.strictEqual(MRP.loadData(s), null);
});

test('调整订单数量后重算：被影响层级/日期全部刷新，不残留旧毛需求与计划单', () => {
  const d = baseData();
  const r1 = MRP.runPlan(d, TODAY);
  assert.strictEqual(rowAt(r1, 'FG', days(10)).gross, 16);

  // 改单：SO-2 从 6 改成 0 视为删除该订单
  d.orders = d.orders.filter(o => o.id !== 'SO-2');
  const r2 = MRP.runPlan(d, TODAY); // 全新结果对象
  assert.notStrictEqual(r1, r2);
  assert.strictEqual(rowAt(r2, 'FG', days(10)).gross, 10);
  assert.strictEqual(posOf(r2, 'FG')[0].qty, 10);
  // SA/W/B/S 全部随 FG=10 重算
  const w5 = rowAt(r2, 'W', days(5));
  assert.ok(Math.abs(w5.gross - 10 * 2 / 0.95) < 1e-6);
  // r1 本身保持第一次计算的快照（证明两次结果互不污染）
  assert.strictEqual(rowAt(r1, 'FG', days(10)).gross, 16);
});

test('调整库存日期后重算：竞用关系按新日期重新建立，旧占用消失', () => {
  const d = baseData();
  const r1 = MRP.runPlan(d, TODAY);
  assert.strictEqual(rowAt(r1, 'W', days(5)).stockAllocated, 4);
  assert.strictEqual(rowAt(r1, 'W', days(8)).stockAllocated, 0);

  // 把 4 件 W 库存从 D5 调到 D8
  d.inventories = d.inventories.filter(s => s.material !== 'W');
  d.inventories.push({ material: 'W', qty: 4, date: days(8) });
  const r2 = MRP.runPlan(d, TODAY);
  assert.strictEqual(rowAt(r2, 'W', days(5)).stockAllocated, 0);
  assert.strictEqual(rowAt(r2, 'W', days(8)).stockAllocated, 4);
  assert.strictEqual(rowAt(r2, 'W', days(8)).net, 28);
});

test('加入制造循环后，原本正常的计划被整体阻断，界面不会保留上一轮计划', () => {
  const d = baseData();
  const r1 = MRP.runPlan(d, TODAY);
  assert.strictEqual(r1.ok, true);
  d.boms.push({ parent: 'S', child: 'FG', qtyPer: 1, scrapRate: 0 });
  const r2 = MRP.runPlan(d, TODAY);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some(e => e.code === 'CYCLE'));
  assert.strictEqual(r2.rows.length, 0);
  assert.strictEqual(r2.plannedOrders.length, 0);
});

console.log('\n[6] 低层码分层');

test('共用件层级取其最深父链（低层码）：成品=0，逐级加深', () => {
  const lv = MRP.computeLevels(MRP.normalizeData(baseData()));
  // 低层码：FG=0；SA=1；W=2（经 FG,SA）；B=3（经 SA→W）；S=3（经 W）
  assert.strictEqual(lv.FG, 0);
  assert.strictEqual(lv.SA, 1);
  assert.strictEqual(lv.W, 2);
  assert.strictEqual(lv.B, 3);
  assert.strictEqual(lv.S, 3);
});

console.log('\n==============================================');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '，全部通过'));
process.exit(failed ? 1 : 0);
