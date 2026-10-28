/* ==========================================================================
 * app.js —— 应用入口：初始化、Tab 路由、新增/编辑单词弹窗、全局快捷键
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils, store = SM.store, dict = SM.dict;
  let currentPage = 'page-learn';

  /* ---------------- 初始化 ---------------- */
  function init() {
    store.load();

    SM.views.learn.init();
    SM.views.mastered.init();
    SM.views.tools.init();

    bindTabs();
    bindHeader();
    bindKeys();

    // 数据变化 -> 各页刷新
    store.subscribe(function (reason) {
      if (!reason) return;
      if (reason.indexOf('word') === 0 || reason.indexOf('data') === 0) {
        SM.views.learn.refresh();
        SM.views.mastered.render();
        SM.views.tools.refresh();
      } else if (reason.indexOf('note') === 0) {
        SM.views.tools.renderNotes();
      }
      updateStats();
    });

    updateStats();
    checkLocalService();

    // 首次使用引导
    if (!store.db.words.length && !localStorage.getItem('supermemo.guided')) {
      localStorage.setItem('supermemo.guided', '1');
      setTimeout(showGuide, 500);
    }
  }

  /* ---------------- 本地服务状态横幅 ----------------
   * 在线词典由项目自带的 server.js 提供（服务端代查有道，绕过浏览器跨域）。
   * 服务没跑起来页面依然能用，但查不到新词，所以这里在首页给出明确指引。
   */
  /** 是否运行在本机/局域网（true = 有可能跑着 server.js） */
  function isPrivateHost(h) {
    h = h || '';
    if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/^192\.168\./.test(h) || /^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;      // 172.16.0.0/12
    if (/^169\.254\./.test(h)) return true;                      // 链路本地
    return false;
  }

  function checkLocalService() {
    const box = u.$('#svcBanner');
    if (!box) return;

    const isFile = location.protocol === 'file:';

    // 部署到公网（GitHub Pages 等）后本来就跑不了本地服务，查词会自动改走
    // 公共词典接口。这时候再弹「后台服务未运行」纯属误报，直接不显示。
    if (!isFile && !isPrivateHost(location.hostname)) return;

    const t = isFile ? 0 : 800;   // 留一点时间给服务响应

    setTimeout(function () {
      if (isFile) { showBanner('file'); return; }
      if (typeof fetch !== 'function') { showBanner('noservice'); return; }
      dict.probeProxy(true)
        .then(ok => { if (!ok) showBanner('noservice'); })
        .catch(() => showBanner('noservice'));
    }, t);

    function showBanner(kind) {
      box.hidden = false;
      if (kind === 'file') {
        box.innerHTML =
          '<b>⚠️ 你是直接双击 index.html 打开的</b>' +
          '这种打开方式下浏览器会拦截跨域请求，在线查词和图片识别都不会工作。<br>' +
          '请改为双击桌面上的 <code>超级记忆</code> 图标，它会自动开启后台服务并打开正确的网址（http://localhost:8124）。';
      } else {
        box.innerHTML =
          '<b>⚠️ 后台服务未运行，在线查词暂时不可用</b>' +
          '请双击桌面上的 <code>超级记忆</code> 图标，它会自动启动后台服务并打开本网站。<br>' +
          '当前的背诵、复习、熟词归档都可以正常使用，只有「查询新单词释义」和「图片 OCR」需要这个后台服务。';
      }
    }
  }

  function showGuide() {
    const body = u.el('div');
    body.innerHTML =
      '<p style="margin:0 0 8px;font-size:14px">欢迎使用 <b>超级记忆</b> 👋</p>' +
      '<p style="margin:0;font-size:13px;color:#6b726d;line-height:1.7">' +
      '① 去「多功能」页导入笔记/文档，或直接粘贴英文文本，自动提取生词；<br>' +
      '② 也可以上传图片，OCR 识别后在图上点选单词；<br>' +
      '③ 回到「生词记忆」页，遮住释义自测，点击单词即可发音；<br>' +
      '④ 记住了就打钩「已熟记」，自动归档进熟词库。</p>';
    u.Modal.open({
      title: '使用小贴士',
      body: body,
      actions: [{ text: '开始使用', type: 'primary', onClick: () => { } }]
    });
  }

  /* ---------------- Tab 切换 ---------------- */
  function bindTabs() {
    u.$$('.tab').forEach(tab => {
      tab.addEventListener('click', () => switchPage(tab.dataset.page));
    });
  }

  function switchPage(pageId) {
    currentPage = pageId;
    u.$$('.page').forEach(p => p.classList.toggle('page-active', p.id === pageId));
    u.$$('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.page === pageId));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (pageId === 'page-tools') SM.views.tools.refresh();
  }

  function bindHeader() {
    u.$('#btnQuickAdd').addEventListener('click', () => openAddModal());
    u.$('#modalMask').addEventListener('click', () => u.Modal.close());
    const qrBtn = u.$('#btnQrCode');
    if (qrBtn) qrBtn.addEventListener('click', openQrModal);
  }

  /* ---------------- 手机扫码弹窗 ----------------
   * 局域网 IP 会变，每次手输网址很麻烦，这里随时能调出二维码让手机扫。
   */
  function openQrModal() {
    const body = u.el('div', { class: 'qr-modal' });
    body.innerHTML = '<p class="loading-line"><span class="spinner"></span>正在获取本机地址…</p>';
    u.Modal.open({
      title: '手机扫码打开', body: body,
      actions: [{ text: '关闭', onClick: () => u.Modal.close() }]
    });
    SM.views.tools.renderQrInto(body);
  }

  /* ---------------- 顶部统计 ---------------- */
  function updateStats() {
    const s = store.stats();
    u.$('#statNew').textContent = s.newCount;
    u.$('#statMaster').textContent = s.master;
    u.$('#statToday').textContent = s.today;
    u.$('#statNote').textContent = s.notes;
    u.$('#headerSub').textContent = s.total ? ('共 ' + s.total + ' 词 · 已掌握 ' + s.master) : '自建词库 · 高效记背';
  }

  /* ======================================================================
   * 新增 / 编辑单词弹窗
   * ==================================================================== */
  function openAddModal(presetWord) {
    openEditModal(null, presetWord);
  }

  /**
   * @param {String|null} id  单词 id（null 表示新增）
   * @param {String} presetWord 预填单词
   */
  function openEditModal(id, presetWord) {
    const editing = id ? store.getById(id) : null;
    const body = u.el('div');

    // —— 查询行 ——
    const fWord = u.el('div', { class: 'field' });
    fWord.appendChild(u.el('label', { text: '英文单词' }));
    const rowWord = u.el('div', { class: 'field-row' });
    const inWord = u.el('input', { type: 'text', placeholder: '例如：abandon', value: (editing && editing.word) || presetWord || '' });
    rowWord.appendChild(inWord);
    const btnQuery = u.el('button', { class: 'act-btn primary', text: '查询', style: 'flex:0 0 72px' });
    rowWord.appendChild(btnQuery);
    fWord.appendChild(rowWord);
    body.appendChild(fWord);

    const tip = u.el('p', { class: 'hint', text: '点击「查询」自动联网获取音标、全部词性与释义、常考短语；无网时可直接手动填写。' });
    body.appendChild(tip);

    // —— 表单区（查询后填充） ——
    const formWrap = u.el('div');
    body.appendChild(formWrap);

    let form = buildForm(editing || { word: presetWord || '', property: [], explain: {}, phrase: [], example: [] });
    formWrap.appendChild(form.node);

    btnQuery.addEventListener('click', function () {
      const w = dict.cleanWord(inWord.value);
      if (!w) { u.toast('请输入单词'); return; }
      btnQuery.disabled = true;
      tip.innerHTML = '<span class="spinner"></span>正在查询「' + u.escapeHtml(w) + '」…';
      dict.lookup(w, { force: true }).then(data => {
        btnQuery.disabled = false;
        if (data && data.source === 'local') {
          tip.textContent = '在线词典不可用，已使用本地离线词库数据（可修改后保存）';
        } else if (!data || data.offline) {
          tip.textContent = '没查到释义（网络不可用且离线词库无此词），请手动补充后仍可保存';
        } else {
          tip.textContent = '查询成功，可修改后保存';
        }
        formWrap.innerHTML = '';
        form = buildForm(Object.assign({}, data, { word: w }));
        formWrap.appendChild(form.node);
      }).catch(() => {
        btnQuery.disabled = false;
        tip.textContent = '网络异常，请手动填写';
      });
    });

    u.Modal.open({
      title: editing ? '编辑单词' : '新增单词',
      body: body,
      actions: [
        { text: '取消' },
        {
          text: '保存', type: 'primary', onClick: () => {
            const data = form.getData();
            data.word = (inWord.value || '').trim() || data.word;
            if (!data.word) { u.toast('单词不能为空'); return; }
            if (editing) {
              store.updateWord(editing.id, data);
              u.toast('已保存');
            } else {
              const r = store.addWord(Object.assign({}, data, { source: data.source || 'manual' }));
              u.toast(r.created ? '已加入生词本' : '词库已存在，已合并释义');
            }
            SM.views.learn.refresh();
            SM.views.mastered.render();
            updateStats();
          }
        }
      ]
    });
  }

  /** 构建可编辑的单词表单 */
  function buildForm(data) {
    data = data || {};
    const node = u.el('div');

    // 音标
    const fPh = u.el('div', { class: 'field' });
    fPh.appendChild(u.el('label', { text: '国际音标' }));
    const inPh = u.el('input', { type: 'text', placeholder: '/əˈbændən/', value: data.phonetic || '' });
    fPh.appendChild(inPh);
    node.appendChild(fPh);

    // 归属笔记
    const fNote = u.el('div', { class: 'field' });
    fNote.appendChild(u.el('label', { text: '归属笔记（可选）' }));
    const selNote = u.el('select');
    selNote.appendChild(u.el('option', { value: '', text: '不关联' }));
    store.db.notes.forEach(n => selNote.appendChild(u.el('option', { value: n.id, text: n.title })));
    selNote.value = data.noteId || '';
    fNote.appendChild(selNote);
    node.appendChild(fNote);

    // 词性 + 释义
    node.appendChild(u.el('label', { class: 'field', text: '词性与释义（每行一条释义）', style: 'font-size:12.5px;color:#6b726d' }));
    const posWrap = u.el('div');
    node.appendChild(posWrap);

    function addPosBlock(pos, defs) {
      const box = u.el('div', { class: 'edit-pos' });
      const r1 = u.el('div', { class: 'field-row' });
      const f1 = u.el('div', { class: 'field' });
      const inPos = u.el('input', { type: 'text', value: pos || '', placeholder: 'n. / v. / adj.' });
      f1.appendChild(inPos);
      r1.appendChild(f1);
      const btnDel = u.el('button', { class: 'act-btn ghost', text: '删除', style: 'flex:0 0 56px;font-size:12px' });
      btnDel.addEventListener('click', () => { posWrap.removeChild(box); });
      r1.appendChild(btnDel);
      box.appendChild(r1);
      const ta = u.el('textarea', { placeholder: '每行一条释义' });
      ta.style.minHeight = '68px';
      ta.value = (defs || []).join('\n');
      box.appendChild(ta);
      posWrap.appendChild(box);
    }

    const props = (data.property || []).length ? data.property : Object.keys(data.explain || {});
    if (props.length) props.forEach(p => addPosBlock(p, (data.explain || {})[p] || []));
    else addPosBlock('n.', []);

    const btnAddPos = u.el('button', { class: 'mini-link', text: '＋ 添加词性', style: 'margin:2px 0 8px' });
    btnAddPos.addEventListener('click', () => addPosBlock('', []));
    node.appendChild(btnAddPos);

    // 常考短语
    const fPh2 = u.el('div', { class: 'field' });
    fPh2.appendChild(u.el('label', { text: '常考短语 / 固定搭配（每行一条）' }));
    const taPhrase = u.el('textarea', { placeholder: 'abandon oneself to 沉溺于' });
    taPhrase.style.minHeight = '68px';
    taPhrase.value = (data.phrase || []).join('\n');
    fPh2.appendChild(taPhrase);
    node.appendChild(fPh2);

    // 例句
    const fEx = u.el('div', { class: 'field' });
    fEx.appendChild(u.el('label', { text: '例句（每行一句，可选）' }));
    const taEx = u.el('textarea', { placeholder: 'He abandoned his car in the snow.' });
    taEx.style.minHeight = '56px';
    taEx.value = (data.example || []).join('\n');
    fEx.appendChild(taEx);
    node.appendChild(fEx);

    return {
      node: node,
      getData: function () {
        const property = [], explain = {};
        u.$$('.edit-pos', posWrap).forEach(box => {
          const p = u.normPos(box.querySelector('input').value.trim());
          const defs = box.querySelector('textarea').value.split('\n').map(s => s.trim()).filter(Boolean);
          if (!p) return;
          if (property.indexOf(p) < 0) property.push(p);
          explain[p] = (explain[p] || []).concat(defs);
        });
        return {
          word: '',
          phonetic: inPh.value.trim(),
          audio: data.audio || '',
          property: property.length ? property : ['other'],
          explain: explain,
          phrase: taPhrase.value.split('\n').map(s => s.trim()).filter(Boolean),
          example: taEx.value.split('\n').map(s => s.trim()).filter(Boolean),
          noteId: selNote.value
        };
      }
    };
  }

  /* ---------------- 全局快捷键（桌面端） ---------------- */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (u.$('#modalRoot').hidden === false) {
        if (e.key === 'Escape') u.Modal.close();
        return;
      }
      if (currentPage !== 'page-learn') return;
      if (e.key === 'ArrowRight') { SM.views.learn.next(); }
      else if (e.key === 'ArrowLeft') { SM.views.learn.prev(); }
      else if (e.key === ' ') { e.preventDefault(); SM.views.learn.toggleMask(); }
      else if (e.key === 'Enter') { SM.views.learn.master(); }
    });
  }

  SM.app = {
    init, switchPage, updateStats,
    openAddModal, openEditModal,
    get page() { return currentPage; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.SM);
