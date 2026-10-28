/* ==========================================================================
 * view-mastered.js —— 页面二：熟词库
 * 已掌握单词汇总 / 搜索 / 词性筛选 / 放回生词本复习
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils, store = SM.store;

  const state = { keyword: '', pos: 'all', checked: {} };
  let els = {};

  function init() {
    els = {
      search: u.$('#masterSearch'),
      searchClear: u.$('#masterSearchClear'),
      chips: u.$('#masterPosFilter'),
      list: u.$('#masterList'),
      count: u.$('#masterListCount'),
      empty: u.$('#masterEmpty'),
      restore: u.$('#btnRestoreChecked')
    };

    els.search.addEventListener('input', u.debounce(function () {
      state.keyword = els.search.value.trim();
      els.searchClear.hidden = !state.keyword;
      render();
    }, 220));
    els.searchClear.addEventListener('click', function () {
      els.search.value = ''; state.keyword = ''; els.searchClear.hidden = true; render();
    });

    els.restore.addEventListener('click', function () {
      const ids = Object.keys(state.checked).filter(k => state.checked[k]);
      if (!ids.length) { u.toast('请先勾选单词'); return; }
      ids.forEach(id => store.setMaster(id, false));
      state.checked = {};
      u.toast('已放回生词本 ' + ids.length + ' 个单词');
      render();
    });

    document.addEventListener('click', function (e) {
      const chip = e.target.closest('#masterPosFilter .chip');
      if (!chip) return;
      state.pos = chip.dataset.pos;
      render();
    });

    render();
  }

  function render() {
    // 词性筛选（熟词范围）
    const stats = store.posStats(true);
    const total = store.stats().master;
    let html = '<button class="chip' + (state.pos === 'all' ? ' active' : '') + '" data-pos="all">全部<span class="num">' + total + '</span></button>';
    stats.forEach(s => {
      html += '<button class="chip' + (state.pos === s.pos ? ' active' : '') + '" data-pos="' + s.pos + '">' +
        s.pos + ' ' + s.cn + '<span class="num">' + s.count + '</span></button>';
    });
    els.chips.innerHTML = html;

    const words = store.listWords({ master: true, pos: state.pos, keyword: state.keyword });
    els.count.textContent = words.length + ' 个熟词';
    els.empty.hidden = words.length > 0;
    els.list.innerHTML = '';

    words.forEach(w => {
      els.list.appendChild(SM.ui.renderWordItem(w, {
        checked: !!state.checked[w.id],
        onToggle: on => { state.checked[w.id] = on; },
        actions: [
          {
            text: '放回生词本',
            onClick: () => { store.setMaster(w.id, false); u.toast('已放回生词本'); render(); }
          },
          { text: '编辑', onClick: () => SM.app.openEditModal(w.id) },
          {
            text: '删除', danger: true,
            onClick: () => {
              u.Modal.confirm('删除熟词', '确定删除「' + w.word + '」吗？', '删除').then(ok => {
                if (ok) { store.removeWord(w.id); render(); }
              });
            }
          }
        ]
      }));
    });
  }

  SM.views = SM.views || {};
  SM.views.mastered = { init, render };
})(window.SM);
