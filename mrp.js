/*
 * mrp.js — 离线物料需求计划核心引擎（无 DOM 依赖，浏览器与 Node 共用）
 *
 * 计算规则：
 *  - 多层 BOM 按低层码逐层展开，同层内"完工日期"升序处理（同日期按需求产生顺序）。
 *  - 毛需求：成品订单需求 + 父件计划单按 BOM 单位用量展开（含损耗率）。
 *  - 净需求 = 毛需求 - 同一时段（同一天）可用库存；库存只能占用与需求同一日期，
 *    不同日期的库存互不挪用，同一日期的多个需求按顺序竞用该日库存。
 *  - 净需求向上取整生成计划单：到货日期 = 需求日期；投产日期 = 到货日期 - 提前期。
 *  - 每次点算都从原始数据完整重算，返回全新结果对象，不残留旧结果。
 *  - 存在任何阻断性错误（缺料、非法数量、重复父子、循环依赖）时不产出计划。
 */
(function (global) {
  'use strict';

  // ---------- 基础工具 ----------

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toISODate(d) {
    if (d instanceof Date) {
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    return String(d);
  }

  function addDays(iso, n) {
    var p = String(iso).split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return toISODate(d);
  }

  function isValidISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // 统一按 6 位小数抹平浮点误差，再取整判断
  function round6(v) {
    return Math.round(v * 1e6) / 1e6;
  }
  function ceilQty(v) {
    return Math.ceil(round6(v));
  }

  function normId(v) {
    return typeof v === 'string' ? v.trim() : String(v == null ? '' : v).trim();
  }

  function err(code, material, message, detail, target) {
    // target: { kind: 'materials'|'inventories'|'orders'|'boms', index } 或其数组
    var targets = null;
    if (target) targets = Array.isArray(target) ? target : [target];
    return { code: code, material: material || '', message: message, detail: detail || '', targets: targets };
  }

  // ---------- 数据规整 ----------

  function normalizeData(input) {
    input = input || {};
    function arr(x) { return Array.isArray(x) ? x : []; }
    return {
      materials: arr(input.materials).map(function (m) {
        return { id: normId(m.id), name: String(m.name == null ? '' : m.name), leadTime: m.leadTime };
      }),
      inventories: arr(input.inventories).map(function (s) {
        return { material: normId(s.material), qty: s.qty, date: toISODate(s.date) };
      }),
      orders: arr(input.orders).map(function (o) {
        return { id: String(o.id == null ? '' : o.id), material: normId(o.material), qty: o.qty, dueDate: toISODate(o.dueDate) };
      }),
      boms: arr(input.boms).map(function (b) {
        return {
          parent: normId(b.parent),
          child: normId(b.child),
          qtyPer: b.qtyPer,
          scrapRate: b.scrapRate == null || b.scrapRate === '' ? 0 : b.scrapRate
        };
      })
    };
  }

  // ---------- 校验 ----------

  function validateData(input) {
    var data = normalizeData(input);
    var errors = [];

    // 物料主数据
    var matSet = Object.create(null);
    data.materials.forEach(function (m, mi) {
      var tm = { kind: 'materials', index: mi };
      if (!m.id) {
        errors.push(err('EMPTY_MATERIAL_ID', '', '存在编码为空的物料（物料表第 ' + (mi + 1) + ' 行），请补全物料编码。', '', tm));
      } else if (Object.prototype.hasOwnProperty.call(matSet, m.id)) {
        errors.push(err('DUPLICATE_MATERIAL', m.id,
          '物料编码重复：' + m.id + '（每个编码只能出现一次）。', '', tm));
      } else {
        matSet[m.id] = mi;
      }
      if (m.id && (!isFiniteNumber(m.leadTime) || m.leadTime < 0 || Math.floor(m.leadTime) !== m.leadTime)) {
        errors.push(err('INVALID_LEAD_TIME', m.id,
          '物料「' + m.id + '」提前期非法：必须是 ≥ 0 的整数（当前值：' + JSON.stringify(m.leadTime) + '）。', '', tm));
      }
    });

    // 库存
    data.inventories.forEach(function (s, i) {
      var ts = { kind: 'inventories', index: i };
      if (!Object.prototype.hasOwnProperty.call(matSet, s.material)) {
        errors.push(err('MISSING_MATERIAL', s.material,
          '库存表第 ' + (i + 1) + ' 行引用了不存在的物料「' + s.material + '」，请先在物料中建档或修正引用。', '', ts));
      }
      if (!isFiniteNumber(s.qty) || s.qty <= 0) {
        errors.push(err('INVALID_QTY', s.material,
          '库存表第 ' + (i + 1) + ' 行（物料「' + s.material + '」）数量非法：必须为大于 0 的数字（当前值：' + JSON.stringify(s.qty) + '）。', '', ts));
      }
      if (!isValidISODate(s.date)) {
        errors.push(err('INVALID_DATE', s.material,
          '库存表第 ' + (i + 1) + ' 行（物料「' + s.material + '」）的可用日期非法：' + s.date + '（应为 YYYY-MM-DD）。', '', ts));
      }
    });

    // 成品订单
    data.orders.forEach(function (o, i) {
      var to = { kind: 'orders', index: i };
      if (!o.id) errors.push(err('EMPTY_ORDER_ID', '', '成品订单第 ' + (i + 1) + ' 行编号为空。', '', to));
      if (!Object.prototype.hasOwnProperty.call(matSet, o.material)) {
        errors.push(err('MISSING_MATERIAL', o.material,
          '成品订单第 ' + (i + 1) + ' 行「' + (o.id || '(未编号)') + '」引用了不存在的物料「' + o.material + '」。', '', to));
      }
      if (!isFiniteNumber(o.qty) || o.qty <= 0) {
        errors.push(err('INVALID_QTY', o.material,
          '成品订单第 ' + (i + 1) + ' 行「' + (o.id || '(未编号)') + '」数量非法：必须为大于 0 的数字（当前值：' + JSON.stringify(o.qty) + '）。', '', to));
      }
      if (!isValidISODate(o.dueDate)) {
        errors.push(err('INVALID_DATE', o.material,
          '成品订单第 ' + (i + 1) + ' 行「' + (o.id || '(未编号)') + '」交货日期非法：' + o.dueDate + '（应为 YYYY-MM-DD）。', '', to));
      }
    });

    // BOM
    var edgeMap = Object.create(null);
    data.boms.forEach(function (b, i) {
      var tb = { kind: 'boms', index: i };
      var where = 'BOM 第 ' + (i + 1) + ' 行（' + b.parent + ' → ' + b.child + '）';
      if (!b.parent || !b.child) {
        errors.push(err('EMPTY_BOM_NODE', b.parent || b.child,
          where + '：父件或子件编码为空。', '', tb));
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(matSet, b.parent)) {
        errors.push(err('MISSING_MATERIAL', b.parent, where + '：父件物料「' + b.parent + '」不存在。', '', tb));
      }
      if (!Object.prototype.hasOwnProperty.call(matSet, b.child)) {
        errors.push(err('MISSING_MATERIAL', b.child, where + '：子件物料「' + b.child + '」不存在。', '', tb));
      }
      if (b.parent === b.child) {
        errors.push(err('CYCLE', b.parent,
          '物料「' + b.parent + '」在 BOM 第 ' + (i + 1) + ' 行引用自身，构成循环依赖。', '', tb));
      }
      if (!isFiniteNumber(b.qtyPer) || b.qtyPer <= 0) {
        errors.push(err('INVALID_QTY', b.child,
          where + '：单位用量非法，必须为大于 0 的数字（当前值：' + JSON.stringify(b.qtyPer) + '）。', '', tb));
      }
      if (!isFiniteNumber(b.scrapRate) || b.scrapRate < 0 || b.scrapRate >= 1) {
        errors.push(err('INVALID_SCRAP', b.child,
          where + '：损耗率非法，必须满足 0 ≤ 损耗率 < 1（当前值：' + JSON.stringify(b.scrapRate) + '）。', '', tb));
      }
      var key = b.parent + '' + b.child;
      if (Object.prototype.hasOwnProperty.call(edgeMap, key)) {
        errors.push(err('DUPLICATE_BOM', b.parent,
          '重复父子关系：「' + b.parent + ' → ' + b.child + '」在 BOM 中出现多次（第 ' +
          (edgeMap[key] + 1) + ' 行与第 ' + (i + 1) + ' 行），同一父子关系只允许一条，数量请合并。', '',
          [{ kind: 'boms', index: edgeMap[key] }, tb]));
      } else {
        edgeMap[key] = i;
      }
    });

    // 循环依赖（仅在物料引用都存在时建图，避免噪声）
    if (!errors.some(function (e) { return e.code === 'MISSING_MATERIAL' || e.code === 'EMPTY_BOM_NODE'; })) {
      var graph = Object.create(null);
      data.boms.forEach(function (b) {
        (graph[b.parent] = graph[b.parent] || []).push(b.child);
      });
      findCycles(graph).forEach(function (chain) {
        // 用环上的边（chain 相邻节点）定位具体 BOM 行
        var edgeIndex = Object.create(null);
        data.boms.forEach(function (b, bi) { edgeIndex[b.parent + '→' + b.child] = bi; });
        var targets = [];
        for (var ci = 0; ci < chain.length - 1; ci++) {
          var ei = edgeIndex[chain[ci] + '→' + chain[ci + 1]];
          if (ei != null) targets.push({ kind: 'boms', index: ei });
        }
        errors.push(err('CYCLE', chain[0],
          'BOM 存在循环依赖：' + chain.join(' → ') + '，无法分层展开。', '', targets));
      });
    }

    return { data: data, errors: errors };
  }

  // DFS 找环，每个环按节点集合去重
  function findCycles(graph) {
    var state = Object.create(null); // 0=未访问 1=在栈中 2=完成
    var stack = [];
    var cycles = [];
    var seen = Object.create(null);

    function visit(node) {
      state[node] = 1;
      stack.push(node);
      (graph[node] || []).forEach(function (nx) {
        if (state[nx] === 1) {
          var idx = stack.indexOf(nx);
          var chain = stack.slice(idx).concat(nx);
          var dedupeKey = chain.slice().sort().join('|');
          if (!seen[dedupeKey]) {
            seen[dedupeKey] = true;
            cycles.push(chain);
          }
        } else if (state[nx] !== 2) {
          visit(nx);
        }
      });
      stack.pop();
      state[node] = 2;
    }

    Object.keys(graph).sort().forEach(function (n) {
      if (!state[n]) visit(n);
    });
    return cycles;
  }

  // ---------- 低层码（low-level code） ----------
  // 成品（无父件）= 0；某物料出现在多层时取最深位置。
  // 这样按层级 0..N 自上而下处理时，任一物料的所有父件都在更小层级、先于它处理。
  function computeLevels(data) {
    var parents = Object.create(null); // child -> [parent]
    data.boms.forEach(function (b) {
      (parents[b.child] = parents[b.child] || []).push(b.parent);
    });
    var memo = Object.create(null);
    function depth(m, onStack) {
      if (memo[m] != null) return memo[m];
      if (onStack[m]) return 0; // 防御：校验已阻断环
      onStack[m] = true;
      var d = 0;
      (parents[m] || []).forEach(function (p) {
        d = Math.max(d, depth(p, onStack) + 1);
      });
      onStack[m] = false;
      memo[m] = d;
      return d;
    }
    var levels = Object.create(null);
    data.materials.forEach(function (m) { levels[m.id] = depth(m.id, Object.create(null)); });
    return levels;
  }

  // ---------- MRP 主计算 ----------

  function runPlan(input, today) {
    var check = validateData(input);
    if (check.errors.length) {
      return { ok: false, errors: check.errors, today: today || null, rows: [], plannedOrders: [], shortages: [], allocations: [] };
    }
    var data = check.data;
    today = today || toISODate(new Date());

    var leadTimeMap = Object.create(null);
    data.materials.forEach(function (m) { leadTimeMap[m.id] = m.leadTime; });

    var childEdges = Object.create(null); // parent -> [{child, qtyPer, scrap}]
    var parentEdges = Object.create(null); // child -> [parent]
    data.boms.forEach(function (b) {
      var eff = b.qtyPer / (1 - b.scrapRate); // 含损耗的有效单位用量
      (childEdges[b.parent] = childEdges[b.parent] || []).push({ child: b.child, eff: eff, raw: b });
      (parentEdges[b.child] = parentEdges[b.child] || []).push(b.parent);
    });

    var levels = computeLevels(data);
    var maxLevel = 0;
    Object.keys(levels).forEach(function (k) { maxLevel = Math.max(maxLevel, levels[k]); });

    // 库存台账：material -> date -> { qty 剩余, initial 初始 }
    var stock = Object.create(null);
    data.inventories.forEach(function (s) {
      var byDate = stock[s.material] || (stock[s.material] = Object.create(null));
      var cur = byDate[s.date] || { initial: 0, qty: 0 };
      cur.initial += s.qty;
      cur.qty += s.qty;
      byDate[s.date] = cur;
    });

    // 毛需求桶：material -> date -> [{qty, source, seq}]，同时按日期保存插入序
    var buckets = Object.create(null);
    var rowOrder = Object.create(null); // material|date -> seq
    var allocations = []; // 库存占用流水
    var plannedOrders = [];
    var seqCounter = 0;

    function addGross(material, date, qty, source) {
      var byDate = buckets[material] || (buckets[material] = Object.create(null));
      var list = byDate[date] || (byDate[date] = []);
      list.push({ qty: round6(qty), source: source, seq: seqCounter++ });
    }

    function datesOf(material) {
      return Object.keys(buckets[material] || {});
    }

    // Level 0：成品订单
    data.orders.forEach(function (o) {
      addGross(o.material, o.dueDate, o.qty, '订单 ' + o.id + '（' + o.dueDate + ' 交货）');
    });

    // 逐层处理：同一 (物料, 日期) 的多笔毛需求先按
    // (日期升序, 需求产生顺序) 逐笔竞用当天库存，再把净需求合并为一张计划单；
    // 计划单的投产日才展开对子件的毛需求。
    for (var level = 0; level <= maxLevel; level++) {
      var groups = [];
      Object.keys(buckets).forEach(function (material) {
        if (levels[material] !== level) return;
        Object.keys(buckets[material]).forEach(function (date) {
          groups.push({ material: material, date: date, entries: buckets[material][date] });
        });
      });
      groups.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        var sa = Math.min.apply(null, a.entries.map(function (e) { return e.seq; }));
        var sb = Math.min.apply(null, b.entries.map(function (e) { return e.seq; }));
        return sa - sb;
      });
      groups.forEach(function (g) {
        var dayStock = stock[g.material] && stock[g.material][g.date];
        var grossSum = 0;
        var allocSum = 0;
        var netSum = 0;
        g.entries.forEach(function (d) {
          var gross = d.qty;
          grossSum = round6(grossSum + gross);
          var available = dayStock ? dayStock.qty : 0;
          var allocated = 0;
          if (available > 0) {
            allocated = Math.min(available, gross);
            dayStock.qty = round6(dayStock.qty - allocated);
            allocations.push({
              material: g.material,
              date: g.date,
              qty: round6(allocated),
              gross: gross,
              source: d.source,
              stockAfter: dayStock.qty
            });
          }
          allocSum = round6(allocSum + allocated);
          netSum = round6(netSum + (gross - allocated));
        });

        if (netSum > 0) {
          var poQty = ceilQty(netSum);
          var lt = leadTimeMap[g.material] || 0;
          var release = addDays(g.date, -lt);
          plannedOrders.push({
            material: g.material,
            needDate: g.date,
            dueDate: g.date,        // 到货日期 = 需求日期
            releaseDate: release,   // 投产日期 = 到货日期 - 提前期
            qty: poQty,
            gross: grossSum,
            allocated: allocSum,
            net: netSum,
            sources: g.entries.map(function (e) { return e.source; }),
            overdue: release < today
          });
          // 展开对子件的毛需求（投产日投料）
          (childEdges[g.material] || []).forEach(function (e) {
            addGross(e.child, release, poQty * e.eff,
              '计划单 ' + g.material + ' ×' + poQty + '（投产 ' + release + '）');
          });
        }
      });
    }

    // 汇总行：material|date
    var rowsMap = Object.create(null);
    function row(material, date) {
      var k = material + '|' + date;
      var r = rowsMap[k];
      if (!r) {
        r = {
          material: material, date: date, level: levels[material] == null ? null : levels[material],
          gross: 0, stockAllocated: 0, net: 0, shortage: 0,
          initialStock: (stock[material] && stock[material][date] ? stock[material][date].initial : 0),
          stockLeft: (stock[material] && stock[material][date] ? stock[material][date].qty : 0),
          sources: []
        };
        rowsMap[k] = r;
      }
      return r;
    }

    // 毛需求 / 来源进汇总
    Object.keys(buckets).forEach(function (material) {
      Object.keys(buckets[material]).forEach(function (date) {
        var r = row(material, date);
        buckets[material][date].forEach(function (d) {
          r.gross = round6(r.gross + d.qty);
          r.sources.push(d.source);
        });
      });
    });
    // 库存占用与净需求进汇总
    allocations.forEach(function (a) {
      var r = row(a.material, a.date);
      r.stockAllocated = round6(r.stockAllocated + a.qty);
    });
    plannedOrders.forEach(function (po) {
      var r = row(po.material, po.needDate);
      r.net = round6(r.net + po.net);
      r.shortage = round6(r.shortage + (po.overdue ? po.net : 0));
    });
    // 有毛需求但当天被库存完全覆盖（无计划单）的行，净需求与缺口为 0，已默认。

    var rows = Object.keys(rowsMap).map(function (k) { return rowsMap[k]; })
      .sort(function (a, b) {
        if (a.level !== b.level) return a.level - b.level;
        if (a.material !== b.material) return a.material < b.material ? -1 : 1;
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });

    plannedOrders.sort(function (a, b) {
      if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? -1 : 1;
      if (a.material !== b.material) return a.material < b.material ? -1 : 1;
      return a.needDate < b.needDate ? -1 : 1;
    });

    var shortages = plannedOrders.filter(function (po) { return po.overdue; })
      .map(function (po) {
        return {
          material: po.material,
          needDate: po.needDate,
          releaseDate: po.releaseDate,
          qty: po.qty,
          message: '物料「' + po.material + '」需 ' + po.needDate + ' 到货，提前期 ' +
            leadTimeMap[po.material] + ' 天，最迟 ' + po.releaseDate + ' 投产，已早于今天（' + today + '），缺口 ' + po.net + '。'
        };
      });

    return {
      ok: true,
      errors: [],
      today: today,
      rows: rows,
      plannedOrders: plannedOrders,
      shortages: shortages,
      allocations: allocations
    };
  }

  // ---------- 本地存档（localStorage） ----------

  var STORE_KEY = 'mrp-workbench-v1';

  function saveData(data, storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) throw new Error('没有可用的本地存储');
    storage.setItem(STORE_KEY, JSON.stringify({ version: 1, data: data, savedAt: new Date().toISOString() }));
  }

  function loadData(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) return null;
    var raw = storage.getItem(STORE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed.data : null;
  }

  function clearData(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (storage) storage.removeItem(STORE_KEY);
  }

  // ---------- 示例数据（多层共用件） ----------

  function seedData(today) {
    today = today || toISODate(new Date());
    return {
      materials: [
        { id: 'FG', name: '成品车', leadTime: 2 },
        { id: 'SA', name: '轮轴组件', leadTime: 3 },
        { id: 'W',  name: '车轮（共用件）', leadTime: 4 },
        { id: 'B',  name: '螺栓（共用件）', leadTime: 1 },
        { id: 'S',  name: '钢材', leadTime: 5 }
      ],
      inventories: [
        { material: 'B', qty: 50, date: addDays(today, 15) },
        { material: 'W', qty: 4,  date: addDays(today, 15) }
      ],
      orders: [
        { id: 'SO-1', material: 'FG', qty: 10, dueDate: addDays(today, 20) },
        { id: 'SO-2', material: 'FG', qty: 6,  dueDate: addDays(today, 20) }
      ],
      boms: [
        { parent: 'FG', child: 'SA', qtyPer: 1, scrapRate: 0 },
        { parent: 'FG', child: 'W',  qtyPer: 2, scrapRate: 0 },
        { parent: 'SA', child: 'W',  qtyPer: 2, scrapRate: 0.05 },
        { parent: 'SA', child: 'B',  qtyPer: 4, scrapRate: 0 },
        { parent: 'W',  child: 'B',  qtyPer: 2, scrapRate: 0 },
        { parent: 'W',  child: 'S',  qtyPer: 3, scrapRate: 0.1 }
      ]
    };
  }

  var api = {
    toISODate: toISODate,
    addDays: addDays,
    isValidISODate: isValidISODate,
    normalizeData: normalizeData,
    validateData: validateData,
    computeLevels: computeLevels,
    runPlan: runPlan,
    saveData: saveData,
    loadData: loadData,
    clearData: clearData,
    seedData: seedData,
    STORE_KEY: STORE_KEY
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.MRP = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
