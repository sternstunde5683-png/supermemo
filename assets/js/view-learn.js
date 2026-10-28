/* ==========================================================================
 * view-learn.js —— 页面一：生词记忆页
 * 卡片背诵 / 列表速览 / 遮罩自测 / 朗读 / 标记熟记 / 词性筛选 / 搜索
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils, store = SM.store;

  const state = {
    mode: 'card',      // card | list
    order: 'seq',      // seq | random
    pos: 'all',        // 当前词性筛选
    keyword: '',
    queue: [],         // 当前学习队列（单词 id）
    index: 0,
    currentId: '',
    masked: true,
    checked: {}        // 列表模式多选：id -> true
  };

  let els = {};

  /* ---------------- 初始化 ---------------- */
  function init() {
    els = {
      search: u.$('#learnSearch'),
      searchClear: u.$('#learnSearchClear'),
      chips: u.$('#learnPosFilter'),
      modeGroup: u.$('#learnMode'),
      orderGroup: u.$('#learnOrder'),
      studyArea: u.$('#studyArea'),
      listArea: u.$('#learnListArea'),
      progress: u.$('#studyProgress'),
      progressText: u.$('#studyProgressText'),
      card: u.$('#wordCard'),
      empty: u.$('#learnEmpty'),
      word: u.$('#wcWord'),
      speak: u.$('#wcSpeak'),
      phonetic: u.$('#wcPhonetic'),
      source: u.$('#wcSource'),
      time: u.$('#wcTime'),
      noteTag: u.$('#wcNoteTag'),
      body: u.$('#wcBody'),
      maskLayer: u.$('#maskLayer'),
      maskBtn: u.$('#maskBtn'),
      meanings: u.$('#wcMeanings'),
      phraseBlock: u.$('#wcPhraseBlock'),
      phrases: u.$('#wcPhrases'),
      exampleBlock: u.$('#wcExampleBlock'),
      examples: u.$('#wcExamples'),
      btnPrev: u.$('#btnPrev'),
      btnNext: u.$('#btnNext'),
      btnMask: u.$('#btnToggleMask'),
      btnMaster: u.$('#btnMaster'),
      btnDelete: u.$('#btnDeleteWord'),
      btnRepeat: u.$('#btnRepeat3'),
      chkAutoSpeak: u.$('#chkAutoSpeak'),
      chkAutoMask: u.$('#chkAutoMask'),
      list: u.$('#learnList'),
      listCount: u.$('#learnListCount'),
      btnMasterChecked: u.$('#btnMasterChecked')
    };

    state.masked = !!store.getSettings().autoMask;
    els.chkAutoSpeak.checked = !!store.getSettings().autoSpeak;
    els.chkAutoMask.checked = state.masked;

    bind();
    refresh();
  }

  function bind() {
    // 搜索
    els.search.addEventListener('input', u.debounce(function () {
      state.keyword = els.search.value.trim();
      els.searchClear.hidden = !state.keyword;
      state.index = 0; state.currentId = '';
      refresh();
    }, 220));
    els.searchClear.addEventListener('click', function () {
      els.search.value = ''; state.keyword = ''; els.searchClear.hidden = true;
      state.index = 0; state.currentId = ''; refresh();
    });

    // 模式 / 顺序
    els.modeGroup.addEventListener('click', function (e) {
      const b = e.target.closest('.seg'); if (!b) return;
      setSeg(els.modeGroup, b);
      state.mode = b.dataset.mode;
      refresh();
    });
    els.orderGroup.addEventListener('click', function (e) {
      const b = e.target.closest('.seg'); if (!b) return;
      setSeg(els.orderGroup, b);
      state.order = b.dataset.order;
      rebuildQueue(true);
      render();
    });

    // 卡片操作
    els.word.addEventListener('click', () => speakCurrent());
    els.speak.addEventListener('click', () => speakCurrent());
    els.btnRepeat.addEventListener('click', () => speakCurrent(3));
    els.maskBtn.addEventListener('click', () => setMask(false));
    els.btnMask.addEventListener('click', () => setMask(!state.masked));
    els.btnPrev.addEventListener('click', () => go(-1));
    els.btnNext.addEventListener('click', () => go(1));
    els.btnMaster.addEventListener('click', masterCurrent);
    els.btnDelete.addEventListener('click', deleteCurrent);

    els.chkAutoSpeak.addEventListener('change', function () {
      store.setSetting('autoSpeak', this.checked);
      SM.views.tools && SM.views.tools.syncSettings();
    });
    els.chkAutoMask.addEventListener('change', function () {
      state.masked = this.checked;
      store.setSetting('autoMask', this.checked);
      setMask(this.checked);
      SM.views.tools && SM.views.tools.syncSettings();
    });

    // 列表批量熟记
    els.btnMasterChecked.addEventListener('click', function () {
      const ids = Object.keys(state.checked).filter(k => state.checked[k]);
      if (!ids.length) { u.toast('请先勾选单词'); return; }
      ids.forEach(id => store.setMaster(id, true));
      state.checked = {};
      u.toast('已熟记 ' + ids.length + ' 个单词');
      refresh();
    });

    // 编辑当前单词
    const btnEdit = u.$('#btnEditWord');
    if (btnEdit) btnEdit.addEventListener('click', function () {
      const w = currentWord();
      if (w) SM.app.openEditModal(w.id);
    });

    // 空状态添加
    const emptyAdd = u.$('#emptyAdd');
    if (emptyAdd) emptyAdd.addEventListener('click', () => SM.app.openAddModal());
  }

  function setSeg(group, btn) {
    u.$$('.seg', group).forEach(b => b.classList.toggle('active', b === btn));
  }

  /* ---------------- 队列维护 ---------------- */
  function rebuildQueue(reshuffle) {
    const list = store.listWords({ master: false, pos: state.pos, keyword: state.keyword });
    const ids = list.map(w => w.id);
    if (state.order === 'random') {
      const kept = state.queue.filter(id => ids.indexOf(id) >= 0);
      const fresh = ids.filter(id => state.queue.indexOf(id) < 0);
      shuffle(fresh);
      state.queue = (reshuffle ? [] : kept).concat(fresh);
      if (reshuffle) shuffle(state.queue);
    } else {
      state.queue = ids; // listWords 已按添加时间倒序
    }
    // 定位当前单词
    if (state.currentId) {
      const i = state.queue.indexOf(state.currentId);
      state.index = i >= 0 ? i : Math.min(state.index, Math.max(0, state.queue.length - 1));
    }
    if (state.index >= state.queue.length) state.index = Math.max(0, state.queue.length - 1);
    if (state.index < 0) state.index = 0;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ---------------- 渲染 ---------------- */
  /** 数据变更后刷新（保持当前位置） */
  function refresh() {
    renderChips();
    rebuildQueue(false);
    render();
  }

  function render() {
    const total = state.queue.length;
    const isCard = state.mode === 'card';
    els.studyArea.hidden = !isCard;
    els.listArea.hidden = isCard;

    // 空状态
    const noData = total === 0;
    if (isCard) {
      els.card.hidden = noData;
      els.empty.hidden = !noData;
    } else {
      els.empty.hidden = true;
    }

    if (noData) {
      els.list.innerHTML = '<div class="empty-state"><div class="empty-emoji">🔍</div><p>没有符合条件的单词</p></div>';
      els.listCount.textContent = '0 个单词';
      els.progress.style.width = '0%';
      els.progressText.textContent = '0 / 0';
      return;
    }

    if (isCard) {
      renderCard();
    } else {
      renderList();
    }
    // 进度
    const pct = total ? (state.index + 1) / total * 100 : 0;
    els.progress.style.width = pct.toFixed(1) + '%';
    els.progressText.textContent = (state.index + 1) + ' / ' + total;
  }

  /* ---------- 词性筛选 chips ---------- */
  function renderChips() {
    const stats = store.posStats(false);
    const total = store.stats().newCount;
    let html = '<button class="chip' + (state.pos === 'all' ? ' active' : '') + '" data-pos="all">全部<span class="num">' + total + '</span></button>';
    stats.forEach(s => {
      html += '<button class="chip' + (state.pos === s.pos ? ' active' : '') + '" data-pos="' + s.pos + '">' +
        s.pos + ' ' + s.cn + '<span class="num">' + s.count + '</span></button>';
    });
    els.chips.innerHTML = html;
  }

  // chips 点击（事件委托，只绑定一次）
  document.addEventListener('click', function (e) {
    const chip = e.target.closest('#learnPosFilter .chip');
    if (!chip) return;
    state.pos = chip.dataset.pos;
    state.index = 0; state.currentId = '';
    refresh();
  });

  /* ---------- 卡片模式 ---------- */
  function currentWord() {
    const id = state.queue[state.index];
    return id ? store.getById(id) : null;
  }

  function renderCard() {
    const w = currentWord();
    if (!w) { state.index = 0; return; }
    state.currentId = w.id;

    els.word.textContent = w.word;
    els.phonetic.textContent = w.phonetic || '';
    const srcMap = {
      api: '在线词典', manual: '手动添加', import: '文档导入', ocr: '图片识别',
      local: '本地离线词库', 'local-stem': '本地离线词库', proxy: '在线词典（本地服务）', 'proxy-en': '在线词典（本地服务）'
    };
    els.source.textContent = srcMap[w.source] || '手动添加';
    els.time.textContent = u.timeAgo(w.createTime) + ' 加入';
    if (w.noteId) {
      const n = store.getNote(w.noteId);
      els.noteTag.hidden = false;
      els.noteTag.textContent = '来自：' + (n ? n.title : '笔记');
    } else {
      els.noteTag.hidden = true;
    }

    renderMeanings(w);
    renderPhrases(w);
    renderExamples(w);

    setMask(state.masked);
    store.markReview(w.id);

    // 自动发音
    if (els.chkAutoSpeak.checked) speakCurrent();
  }

  /** 渲染每个词性的释义 */
  function renderMeanings(w) {
    const frag = document.createDocumentFragment();
    const props = (w.property || []).length ? w.property : Object.keys(w.explain || {});
    props.forEach(pos => {
      const defs = (w.explain || {})[pos] || [];
      if (!defs.length) return;
      const item = u.el('div', { class: 'meaning-item' });
      item.appendChild(u.el('span', { class: 'pos-badge ' + u.posClass(pos), text: pos + ' ' + u.posCn(pos) }));
      const ul = u.el('ul');
      defs.forEach(d => {
        // 释义存储格式：「英文释义  【中文释义】」——中文为主、英文原文作对照小字
        const parts = String(d).match(/^(.*?)【(.*)】\s*$/);
        if (parts) {
          ul.appendChild(u.el('li', {
            html: u.escapeHtml(parts[2].trim()) + ' <em>' + u.escapeHtml(parts[1].trim()) + '</em>'
          }));
        } else {
          ul.appendChild(u.el('li', { text: d }));
        }
      });
      item.appendChild(ul);
      frag.appendChild(item);
    });
    if (!frag.childNodes.length) {
      frag.appendChild(u.el('div', {
        class: 'meaning-item',
        html: '<span class="hint">该单词暂无释义，可在多功能页重新联网查询或手动编辑补充</span>'
      }));
    }
    els.meanings.innerHTML = '';
    els.meanings.appendChild(frag);
  }

  function renderPhrases(w) {
    const list = w.phrase || [];
    els.phraseBlock.hidden = !list.length;
    els.phrases.innerHTML = '';
    list.forEach(p => {
      const li = u.el('li');
      // 「短语  中文」格式：加粗短语部分
      const m = String(p).match(/^([A-Za-z][A-Za-z\s'’\-]*?)\s+([\u4e00-\u9fa5].*)$/);
      if (m) {
        li.appendChild(u.el('b', { text: m[1] }));
        li.appendChild(document.createTextNode(' ' + m[2]));
      } else {
        li.textContent = p;
      }
      els.phrases.appendChild(li);
    });
  }

  function renderExamples(w) {
    const list = w.example || [];
    els.exampleBlock.hidden = !list.length;
    els.examples.innerHTML = '';
    list.forEach(ex => els.examples.appendChild(u.el('li', { text: ex })));
  }

  /* ---------- 列表模式 ---------- */
  function renderList() {
    const words = state.queue.map(id => store.getById(id)).filter(Boolean);
    els.listCount.textContent = words.length + ' 个单词';
    els.list.innerHTML = '';
    words.forEach(w => {
      els.list.appendChild(SM.ui.renderWordItem(w, {
        checked: !!state.checked[w.id],
        onToggle: (on) => { state.checked[w.id] = on; },
        actions: [
          { text: '熟记', onClick: () => { store.setMaster(w.id, true); u.toast('已熟记 ' + w.word); refresh(); } },
          { text: '删除', danger: true, onClick: () => { store.removeWord(w.id); refresh(); } }
        ]
      }));
    });
  }

  /* ---------------- 交互动作 ---------------- */
  function setMask(mask) {
    state.masked = !!mask;
    els.maskLayer.classList.toggle('hidden', !state.masked);
    els.btnMask.textContent = state.masked ? '显示释义' : '遮住释义';
  }

  function go(step) {
    if (!state.queue.length) return;
    let i = state.index + step;
    if (i < 0) i = state.queue.length - 1;
    if (i >= state.queue.length) i = 0;
    state.index = i;
    render();
  }

  function speakCurrent(times) {
    const w = currentWord();
    if (!w) return;
    SM.speech.speak(w.word, {
      times: times || 1,
      audio: w.audio || '',
      onStart: () => els.speak && els.speak.classList.add('speaking'),
      onEnd: () => els.speak && els.speak.classList.remove('speaking'),
      onFail: () => {
        els.speak && els.speak.classList.remove('speaking');
        u.toast('发音失败：请确认手机没静音、音量已开且能联网');
      }
    });
  }

  function masterCurrent() {
    const w = currentWord();
    if (!w) return;
    store.setMaster(w.id, true);
    store.save();
    u.toast('✓ ' + w.word + ' 已移入熟词库');
    refresh();
  }

  function deleteCurrent() {
    const w = currentWord();
    if (!w) return;
    u.Modal.confirm('删除单词', '确定从生词本删除「' + w.word + '」吗？', '删除').then(ok => {
      if (!ok) return;
      store.removeWord(w.id);
      refresh();
      u.toast('已删除');
    });
  }

  /** 跳转到指定单词（供其他页面调用） */
  function focusWord(id) {
    SM.app.switchPage('page-learn');
    state.mode = 'card';
    setSeg(els.modeGroup, u.$('#learnMode .seg[data-mode="card"]'));
    state.keyword = ''; els.search.value = ''; els.searchClear.hidden = true;
    state.pos = 'all';
    rebuildQueue(false);
    const i = state.queue.indexOf(id);
    if (i >= 0) { state.index = i; state.currentId = id; }
    render();
  }

  /** 按词性筛选（供多功能页「词性分类」跳转调用） */
  function setPos(pos) {
    state.pos = pos;
    state.index = 0; state.currentId = '';
    renderChips();
    rebuildQueue(false);
    render();
  }

  /** 与设置页开关联动 */
  function syncSwitches() {
    const st = store.getSettings();
    els.chkAutoSpeak.checked = !!st.autoSpeak;
    els.chkAutoMask.checked = !!st.autoMask;
  }

  SM.views = SM.views || {};
  SM.views.learn = {
    init, refresh, focusWord, setPos, syncSwitches, state,
    next: () => go(1),
    prev: () => go(-1),
    toggleMask: () => setMask(!state.masked),
    master: masterCurrent,
    get current() { return currentWord(); }
  };

  /* ==========================================================================
   * 公共 UI：单词列表项（生词页 / 熟词页共用）
   * ========================================================================== */
  SM.ui = SM.ui || {};
  SM.ui.renderWordItem = function (w, opt) {
    opt = opt || {};
    const item = u.el('div', { class: 'wl-item', dataset: { id: w.id } });

    // 顶部：勾选 + 单词 + 音标
    const top = u.el('div', { class: 'wl-top' });
    if (opt.checkable !== false) {
      const chk = u.el('div', { class: 'wl-check' + (opt.checked ? ' on' : ''), html: opt.checked ? '✓' : '', title: '勾选' });
      chk.addEventListener('click', e => {
        e.stopPropagation();
        const on = !chk.classList.contains('on');
        chk.classList.toggle('on', on);
        chk.innerHTML = on ? '✓' : '';
        opt.onToggle && opt.onToggle(on);
      });
      top.appendChild(chk);
    }
    const wordEl = u.el('span', { class: 'wl-word', text: w.word });
    wordEl.addEventListener('click', () => SM.speech.speak(w.word, {
      audio: w.audio || '',
      onFail: () => u.toast('发音失败：请确认手机没静音、音量已开且能联网')
    }));
    top.appendChild(wordEl);
    top.appendChild(u.el('span', { class: 'wl-ph', text: w.phonetic || '' }));
    item.appendChild(top);

    // 释义摘要
    const summary = [];
    (w.property || []).forEach(pos => {
      const defs = (w.explain || {})[pos] || [];
      if (!defs.length) return;
      // 摘要优先展示中文释义（「英文【中文】」）
      const m = String(defs[0]).match(/【(.*)】/);
      summary.push(pos + ' ' + (m ? m[1].trim() : defs[0]));
    });
    item.appendChild(u.el('div', { class: 'wl-mean', text: summary.join('；') || '暂无释义' }));

    // 展开详情
    const open = u.el('span', { class: 'wl-open', text: '展开详情 ▾' });
    const detail = u.el('div', { class: 'wl-detail' });
    (w.property || []).forEach(pos => {
      const defs = (w.explain || {})[pos] || [];
      if (!defs.length) return;
      const mi = u.el('div', { class: 'meaning-item' });
      mi.appendChild(u.el('span', { class: 'pos-badge ' + u.posClass(pos), text: pos + ' ' + u.posCn(pos) }));
      const ul = u.el('ul');
      defs.forEach(d => ul.appendChild(u.el('li', { text: d })));
      mi.appendChild(ul);
      detail.appendChild(mi);
    });
    if ((w.phrase || []).length) {
      const pb = u.el('div', { class: 'phrase-block' });
      pb.appendChild(u.el('h4', { text: '常考搭配 / 短语' }));
      const ul = u.el('ul');
      w.phrase.forEach(p => ul.appendChild(u.el('li', { text: p })));
      pb.appendChild(ul);
      detail.appendChild(pb);
    }
    open.addEventListener('click', () => {
      const show = !detail.classList.contains('show');
      detail.classList.toggle('show', show);
      open.textContent = show ? '收起 ▴' : '展开详情 ▾';
    });
    item.appendChild(open);
    item.appendChild(detail);

    // 操作
    if (opt.actions && opt.actions.length) {
      const ops = u.el('div', { class: 'wl-ops' });
      opt.actions.forEach(a => {
        ops.appendChild(u.el('button', {
          class: a.danger ? 'danger' : '',
          text: a.text,
          onClick: e => { e.stopPropagation(); a.onClick(); }
        }));
      });
      item.appendChild(ops);
    }
    return item;
  };
})(window.SM);
