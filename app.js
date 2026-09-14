/* app.js — 离线 MRP 工作台交互层（依赖 mrp.js）
 *
 * 设计要点：
 *  - state 是唯一数据源；任意编辑都先改 state → 保存 localStorage → 整体重算并重渲染，
 *    结果区域只由最新一次 runPlan 的返回对象生成，因此调整订单/库存后不可能残留旧结果。
 *  - runPlan 校验失败时，结果面板只显示错误阻断信息，不展示任何旧计划表。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------

  function emptyData() {
    return { materials: [], inventories: [], orders: [], boms: [] };
  }

  function genId(prefix) {
    genId.n = (genId.n || 0) + 1;
    return prefix + '-' + Date.now().toString(36) + '-' + genId.n;
  }

  function defaultRow(kind, data) {
    var today = MRP.toISODate(new Date());
    if (kind === 'materials') return { id: '', name: '', leadTime: 1 };
    if (kind === 'inventories') {
      return { _id: genId('inv'), material: firstMaterial(data), qty: 0, date: today };
    }
    if (kind === 'orders') {
      return { _id: genId('ord'), id: '', material: firstMaterial(data), qty: 0, dueDate: today };
    }
    return { _id: genId('bom'), parent: firstMaterial(data), child: '', qtyPer: 1, scrapRate: 0 };
  }
  function firstMaterial(data) {
    return data.materials.length && data.materials[0].id ? data.materials[0].id : '';
  }
  // 保证数组元素都有内部行 id
  function ensureRowIds(data) {
    data.inventories.forEach(function (r, i) { if (!r._id) r._id = genId('inv') + '-' + i; });
    data.orders.forEach(function (r, i) { if (!r._id) r._id = genId('ord') + '-' + i; });
    data.boms.forEach(function (r, i) { if (!r._id) r._id = genId('bom') + '-' + i; });
  }

  var state = {
    data: emptyData(),
    tab: 'orders',
    result: null
  };

  // ---------- 持久化 ----------

  var savedAtEl = document.getElementById('savedAt');
  function persist() {
    try {
      MRP.saveData(state.data);
      savedAtEl.textContent = '已保存 ' + new Date().toLocaleTimeString();
    } catch (e) {
      savedAtEl.textContent = '保存失败：' + e.message;
    }
  }

  function restore() {
    var loaded = null;
    try { loaded = MRP.loadData(); } catch (e) { loaded = null; }
    if (loaded && Array.isArray(loaded.materials)) {
      state.data = loaded;
      ensureRowIds(state.data);
      return true;
    }
    return false;
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return esc(v);
    var r = Math.round(v * 1000) / 1000;
    return String(r);
  }
  function matName(id) {
    var m = state.data.materials.filter(function (x) { return x.id === id; })[0];
    return m && m.name ? m.name : '';
  }

  // 把引擎错误按内部行定位，标记需要高亮的行
  function buildErrorIndex(errors) {
    var idx = { materials: {}, inventories: {}, orders: {}, boms: {} };
    function mark(kind, key) { if (key) idx[kind][key] = true; }
    errors.forEach(function (e) {
      if (e.code === 'DUPLICATE_MATERIAL' || e.code === 'INVALID_LEAD_TIME' || e.code === 'EMPTY_MATERIAL_ID') {
        mark('materials', e.material);
      }
      if (e.code === 'INVALID_QTY') {
        // 数量错误可能来自库存/订单/BOM，按存在性都标，由消息说明位置
        state.data.inventories.forEach(function (r) { if (r.material === e.material) mark('inventories', r._id); });
        state.data.orders.forEach(function (r) { if (r.material === e.material) mark('orders', r._id); });
        state.data.boms.forEach(function (r) { if (r.parent === e.material || r.child === e.material) mark('boms', r._id); });
      }
      if (e.code === 'INVALID_DATE') {
        state.data.inventories.forEach(function (r) { if (r.material === e.material) mark('inventories', r._id); });
        state.data.orders.forEach(function (r) { if (r.material === e.material) mark('orders', r._id); });
      }
      if (e.code === 'MISSING_MATERIAL') {
        state.data.inventories.forEach(function (r) { if (r.material === e.material) mark('inventories', r._id); });
        state.data.orders.forEach(function (r) { if (r.material === e.material) mark('orders', r._id); });
        state.data.boms.forEach(function (r) { if (r.parent === e.material || r.child === e.material) mark('boms', r._id); });
      }
      if (e.code === 'DUPLICATE_BOM' || e.code === 'INVALID_SCRAP' || e.code === 'EMPTY_BOM_NODE') {
        state.data.boms.forEach(function (r) {
          if (r.parent === e.material || r.child === e.material) mark('boms', r._id);
        });
      }
    });
    return idx;
  }

  // ---------- 编辑器渲染 ----------

  var editorPanel = document.getElementById('editorPanel');
  var resultPanel = document.getElementById('resultPanel');
  var errorBanner = document.getElementById('errorBanner');

  var TAB_META = {
    orders: { title: '成品订单（独立需求）', hint: '订单在交货日期产生成品毛需求；同日多单按录入顺序竞用当天库存。' },
    materials: { title: '物料主数据与提前期', hint: '提前期为非负整数（天）；BOM、库存、订单只能引用这里登记过的物料编码。' },
    inventories: { title: '现有库存（按可用日期分桶）', hint: '库存只能被同一日期的需求占用，不会挪用到其它日期。修改日期即改变竞用关系。' },
    boms: { title: '多层物料清单', hint: '单位用量 = 每生产 1 件父件所需子件数；损耗率取 0~1 之间（如 0.05 表示 5%）。同一父子关系只能有一行。' }
  };

  function materialOptions(selected) {
    var opts = ['<option value="">选择物料…</option>']
      .concat(state.data.materials.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === selected ? ' selected' : '') + '>' +
          esc(m.id) + (m.name ? '（' + esc(m.name) + '）' : '') + '</option>';
      }));
    return opts.join('');
  }

  function cellInput(kind, rowId, field, value, extra) {
    extra = extra || {};
    var type = extra.type || 'text';
    var step = extra.step != null ? ' step="' + extra.step + '"' : '';
    var min = extra.min != null ? ' min="' + extra.min + '"' : '';
    var cls = extra.num ? 'num' : '';
    return '<input class="' + cls + '" data-kind="' + kind + '" data-id="' + esc(rowId) +
      '" data-field="' + field + '" type="' + type + '"' + step + min +
      ' value="' + esc(value) + '">';
  }

  function delButton(kind, rowId) {
    return '<button class="del" data-act="del" data-kind="' + kind + '" data-id="' + esc(rowId) +
      '" title="删除该行">✕</button>';
  }

  function renderEditor(errIdx) {
    var tab = state.tab, meta = TAB_META[tab];
    var rows = state.data[tab];
    var h = '<h2>' + meta.title + '</h2><p class="hint">' + meta.hint + '</p>';
    h += '<div class="scroll"><table>';

    if (tab === 'materials') {
      h += '<thead><tr><th style="width:130px">物料编码</th><th>名称</th><th style="width:110px">提前期(天)</th><th style="width:42px"></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var bad = errIdx.materials[r.id] ? ' class="row-err"' : '';
        h += '<tr' + bad + '><td>' + cellInput('materials', r.id, 'id', r.id) + '</td>' +
          '<td>' + cellInput('materials', r.id, 'name', r.name) + '</td>' +
          '<td class="num">' + cellInput('materials', r.id, 'leadTime', r.leadTime, { type: 'number', step: 1, min: 0, num: true }) + '</td>' +
          '<td>' + delButton('materials', r.id) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    if (tab === 'inventories') {
      h += '<thead><tr><th style="width:170px">物料</th><th style="width:120px">数量</th><th style="width:150px">可用日期</th><th style="width:42px"></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var bad = errIdx.inventories[r._id] ? ' class="row-err"' : '';
        h += '<tr' + bad + '><td><select data-kind="inventories" data-id="' + esc(r._id) +
          '" data-field="material">' + materialOptions(r.material) + '</select></td>' +
          '<td class="num">' + cellInput('inventories', r._id, 'qty', r.qty, { type: 'number', step: 'any', min: 0, num: true }) + '</td>' +
          '<td>' + cellInput('inventories', r._id, 'date', r.date, { type: 'date' }) + '</td>' +
          '<td>' + delButton('inventories', r._id) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    if (tab === 'orders') {
      h += '<thead><tr><th style="width:120px">订单编号</th><th style="width:170px">成品物料</th><th style="width:110px">数量</th><th style="width:150px">交货日期</th><th style="width:42px"></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var bad = errIdx.orders[r._id] ? ' class="row-err"' : '';
        h += '<tr' + bad + '><td>' + cellInput('orders', r._id, 'id', r.id) + '</td>' +
          '<td><select data-kind="orders" data-id="' + esc(r._id) + '" data-field="material">' +
          materialOptions(r.material) + '</select></td>' +
          '<td class="num">' + cellInput('orders', r._id, 'qty', r.qty, { type: 'number', step: 'any', min: 0, num: true }) + '</td>' +
          '<td>' + cellInput('orders', r._id, 'dueDate', r.dueDate, { type: 'date' }) + '</td>' +
          '<td>' + delButton('orders', r._id) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    if (tab === 'boms') {
      h += '<thead><tr><th style="width:170px">父件</th><th style="width:170px">子件</th><th style="width:110px">单位用量</th><th style="width:100px">损耗率</th><th style="width:42px"></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var bad = errIdx.boms[r._id] ? ' class="row-err"' : '';
        h += '<tr' + bad + '><td><select data-kind="boms" data-id="' + esc(r._id) + '" data-field="parent">' +
          materialOptions(r.parent) + '</select></td>' +
          '<td><select data-kind="boms" data-id="' + esc(r._id) + '" data-field="child">' +
          materialOptions(r.child) + '</select></td>' +
          '<td class="num">' + cellInput('boms', r._id, 'qtyPer', r.qtyPer, { type: 'number', step: 'any', min: 0, num: true }) + '</td>' +
          '<td class="num">' + cellInput('boms', r._id, 'scrapRate', r.scrapRate, { type: 'number', step: 'any', min: 0, num: true }) + '</td>' +
          '<td>' + delButton('boms', r._id) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    h += '<div class="addrow"><button data-act="add" data-kind="' + tab + '">＋ 新增一行</button> ' +
      '<span class="tiny">共 ' + rows.length + ' 行</span></div>';
    editorPanel.innerHTML = h;
  }

  // ---------- 结果渲染 ----------

  function renderResult() {
    var r = state.result;
    var today = r ? r.today : MRP.toISODate(new Date());

    // 错误横幅（阻断）
    if (!r || !r.ok) {
      var errs = r ? r.errors : [];
      var h = '<div class="banner err"><b>⛔ 点算被阻断：发现 ' + errs.length +
        ' 个数据错误，未生成任何计划（修正前不会保留上一轮结果）。</b><ul>';
      h += errs.map(function (e) { return '<li>' + esc(e.message) + '</li>'; }).join('');
      h += '</ul></div>';
      errorBanner.innerHTML = h;
      resultPanel.innerHTML = '<h2>计算结果</h2><p class="hint">数据存在错误，计划未产出。请按上方清单修正后重新点算。</p>';
      return;
    }

    errorBanner.innerHTML = '';
    var shortageQty = r.shortages.reduce(function (a, s) { return a + s.qty; }, 0);
    var html = '<h2>计算结果</h2><p class="hint">计算基准日（今天）：' + today +
      '　|　低层码自上而下逐层展开，库存仅占用同日需求。</p>';

    html += '<div class="summary">' +
      kpi(r.rows.length, '物料·日期需求行') +
      kpi(r.plannedOrders.length, '计划单（投产/到货）') +
      kpi(r.allocations.length, '库存占用批次') +
      '<div class="kpi ' + (r.shortages.length ? 'bad' : '') + '"><div class="v">' + r.shortages.length +
      '</div><div class="k">缺料项 / 缺口 ' + fmt(shortageQty) + '</div></div></div>';

    if (r.shortages.length) {
      html += '<div class="banner warn"><b>⚠ 以下 ' + r.shortages.length + ' 项按提前期倒排后，投产日期已早于今天，存在缺口：</b><ul>' +
        r.shortages.map(function (s) { return '<li>' + esc(s.message) + '</li>'; }).join('') + '</ul></div>';
    } else {
      html += '<div class="banner ok"><b>✓ 点算完成：无阻断错误，所有计划单均可在今天之后投产。</b></div>';
    }

    // 逐层毛需求 / 净需求
    html += '<h2 style="margin-top:16px">逐层毛需求 / 净需求</h2><div class="scroll"><table>' +
      '<thead><tr><th>层级</th><th>物料</th><th>需求日期</th><th class="num">毛需求</th>' +
      '<th class="num">同日库存占用</th><th class="num">净需求</th><th class="num">缺口</th><th>需求来源</th></tr></thead><tbody>';
    html += r.rows.map(function (row) {
      var name = matName(row.material);
      var src = (row.sources || []).map(esc).join('；');
      return '<tr><td><span class="pill lvl0">L' + row.level + '</span></td>' +
        '<td><b>' + esc(row.material) + '</b>' + (name ? '<div class="tiny">' + esc(name) + '</div>' : '') + '</td>' +
        '<td>' + esc(row.date) + '</td>' +
        '<td class="num">' + fmt(row.gross) + '</td>' +
        '<td class="num">' + (row.stockAllocated > 0 ? '<span class="stock-tag">' + fmt(row.stockAllocated) + '</span>' : '0') +
        (row.initialStock ? ' <span class="tiny">(当日库存 ' + fmt(row.initialStock) + '，余 ' + fmt(row.stockLeft) + ')</span>' : '') + '</td>' +
        '<td class="num ' + (row.net === 0 ? 'netzero' : '') + '">' + fmt(row.net) + '</td>' +
        '<td class="num">' + (row.shortage > 0 ? '<span class="pill short">缺 ' + fmt(row.shortage) + '</span>' : '0') + '</td>' +
        '<td><div class="src">' + src + '</div></td></tr>';
    }).join('');
    html += '</tbody></table></div>';

    // 计划单：投产 / 到货
    html += '<h2 style="margin-top:18px">投产与到货倒排</h2><div class="scroll"><table>' +
      '<thead><tr><th>物料</th><th>计划数量</th><th>投产日期</th><th>到货日期(=需求日)</th>' +
      '<th class="num">毛需求</th><th class="num">库存占用</th><th class="num">净需求</th><th>状态</th></tr></thead><tbody>';
    html += r.plannedOrders.map(function (p) {
      return '<tr' + (p.overdue ? ' class="row-err"' : '') + '>' +
        '<td><b>' + esc(p.material) + '</b></td>' +
        '<td class="num">' + fmt(p.qty) + '</td>' +
        '<td>' + esc(p.releaseDate) + '</td>' +
        '<td>' + esc(p.dueDate) + '</td>' +
        '<td class="num">' + fmt(p.gross) + '</td>' +
        '<td class="num">' + fmt(p.allocated) + '</td>' +
        '<td class="num">' + fmt(p.net) + '</td>' +
        '<td>' + (p.overdue ? '<span class="pill short">投产已晚</span>' : '<span class="pill">可投产</span>') + '</td></tr>';
    }).join('');
    html += '</tbody></table></div>';

    resultPanel.innerHTML = html;
  }

  function kpi(v, k) {
    return '<div class="kpi"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  // ---------- 主刷新 ----------

  var EMPTY_IDX = function () { return { materials: {}, inventories: {}, orders: {}, boms: {} }; };

  function recomputeAndRender() {
    state.result = MRP.runPlan(state.data);
    var errIdx = state.result.ok ? EMPTY_IDX() : buildErrorIndex(state.result.errors);
    renderEditor(errIdx);
    renderResult();
  }

  // 轻量刷新：编辑单元格时只更新结果区与行高亮，不重建编辑器，
  // 避免输入过程中 DOM 重建导致焦点/光标丢失（结构增删、切页才整体重渲染）。
  function applyHighlights() {
    var errIdx = state.result.ok ? EMPTY_IDX() : buildErrorIndex(state.result.errors);
    var set = errIdx[state.tab] || {};
    var trs = editorPanel.querySelectorAll('tbody tr');
    Array.prototype.forEach.call(trs, function (tr) {
      var idEl = tr.querySelector('[data-id]');
      tr.classList.toggle('row-err', !!(idEl && set[idEl.dataset.id]));
    });
  }

  function commit() {
    persist();
    state.result = MRP.runPlan(state.data);
    renderResult();
    applyHighlights();
  }

  function commitFull() {
    persist();
    recomputeAndRender();
  }

  // ---------- 事件 ----------

  document.getElementById('tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (!t) return;
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
    recomputeAndRender();
  });

  editorPanel.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.kind) return;
    var kind = el.dataset.kind, id = el.dataset.id, field = el.dataset.field;
    var row = state.data[kind].filter(function (x) {
      return kind === 'materials' ? x.id === id : x._id === id;
    })[0];
    if (!row) return;
    if (field === 'qty' || field === 'qtyPer' || field === 'scrapRate' || field === 'leadTime') {
      row[field] = el.value === '' ? '' : Number(el.value);
    } else {
      row[field] = el.value;
    }
    el.classList.remove('bad');
    commit();
  });

  editorPanel.addEventListener('change', function (e) {
    // select / date 的变更 input 事件在多数浏览器已覆盖，change 再兜底持久化一次
    if (e.target && e.target.dataset && e.target.dataset.kind) commit();
  });

  editorPanel.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var kind = b.dataset.kind;
    if (b.dataset.act === 'add') {
      state.data[kind].push(defaultRow(kind, state.data));
      commitFull();
    } else if (b.dataset.act === 'del') {
      var id = b.dataset.id;
      state.data[kind] = state.data[kind].filter(function (x) {
        return kind === 'materials' ? x.id !== id : x._id !== id;
      });
      // 物料删除后，引用它的行由校验阻断并提示，不静默删除
      commitFull();
    }
  });

  document.getElementById('btnRun').addEventListener('click', function () {
    persist();
    recomputeAndRender();
  });

  document.getElementById('btnSeed').addEventListener('click', function () {
    if (!confirm('载入多层共用件示例数据？当前未导出的本地数据会被覆盖。')) return;
    state.data = MRP.seedData();
    ensureRowIds(state.data);
    commitFull();
  });

  document.getElementById('btnClear').addEventListener('click', function () {
    if (!confirm('清空全部物料、库存、订单与 BOM？此操作只影响本机浏览器数据。')) return;
    state.data = emptyData();
    MRP.clearData();
    recomputeAndRender();
    savedAtEl.textContent = '已清空';
  });

  document.getElementById('btnExport').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mrp-data-' + MRP.toISODate(new Date()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('btnImport').addEventListener('click', function () {
    document.getElementById('fileImport').click();
  });
  document.getElementById('fileImport').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        ['materials', 'inventories', 'orders', 'boms'].forEach(function (k) {
          if (!Array.isArray(parsed[k])) throw new Error('缺少数组字段：' + k);
        });
        state.data = parsed;
        ensureRowIds(state.data);
        commitFull();
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---------- 启动：刷新后恢复，否则给示例 ----------

  if (!restore()) {
    state.data = MRP.seedData();
    ensureRowIds(state.data);
    persist();
  }
  recomputeAndRender();
})();
