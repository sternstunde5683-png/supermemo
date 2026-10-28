/* ==========================================================================
 * view-tools.js —— 页面三：多功能选项页
 * 文档/文本导入 · 图片 OCR 框选取词 · 笔记管理 · 词性分类 · 设置与数据
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils, store = SM.store, dict = SM.dict, importer = SM.importer, ocr = SM.ocr;

  /** 候选词缓存：[{word,count,on}] */
  let candidates = [];
  let els = {};

  function init() {
    els = {
      dropZone: u.$('#dropZone'),
      fileInput: u.$('#fileInput'),
      pasteArea: u.$('#pasteArea'),
      btnExtract: u.$('#btnExtract'),
      btnSaveNote: u.$('#btnSaveNote'),
      candArea: u.$('#candidateArea'),
      candList: u.$('#candList'),
      candCount: u.$('#candCount'),
      btnCandAll: u.$('#btnCandAll'),
      btnCandNone: u.$('#btnCandNone'),
      btnAddCand: u.$('#btnAddCandidates'),
      // OCR
      ocrZone: u.$('#ocrZone'),
      ocrInput: u.$('#ocrInput'),
      btnPickImage: u.$('#btnPickImage'),
      ocrPlaceholder: u.$('#ocrPlaceholder'),
      ocrStage: u.$('#ocrStage'),
      ocrImage: u.$('#ocrImage'),
      ocrViewport: u.$('#ocrViewport'),
      ocrScene: u.$('#ocrScene'),
      ocrBoxes: u.$('#ocrBoxes'),
      ocrRegions: u.$('#ocrRegions'),
      ocrModeGroup: u.$('#ocrModeGroup'),
      ocrZoomIn: u.$('#ocrZoomIn'),
      ocrZoomOut: u.$('#ocrZoomOut'),
      ocrZoomFit: u.$('#ocrZoomFit'),
      ocrZoomVal: u.$('#ocrZoomVal'),
      ocrStatus: u.$('#ocrStatus'),
      ocrResult: u.$('#ocrResult'),
      btnOcrAll: u.$('#btnOcrSelectAll'),
      btnOcrAdd: u.$('#btnOcrAdd'),
      // 笔记
      noteList: u.$('#noteList'),
      btnNewNote: u.$('#btnNewNote'),
      // 分类 / 数据
      catStats: u.$('#categoryStats'),
      cacheCount: u.$('#cacheCount'),
      sets: {
        autoQuery: u.$('#setAutoQuery'),
        translate: u.$('#setTranslate'),
        phrase: u.$('#setPhrase'),
        autoSpeak: u.$('#setAutoSpeak'),
        autoMask: u.$('#setAutoMask'),
        accent: u.$('#setAccent')
      }
    };

    bindImport();
    bindOcr();
    bindNotes();
    bindSettings();
    renderNotes();
    renderCatStats();
    checkEnv();
    bindDictState();
    renderQrPanel();
    bindSync();
    applyPairLink();
    els.cacheCount.textContent = dict.cacheCount();
    const lc = u.$('#localCount');
    if (lc) lc.textContent = dict.localCount();
  }

  /* ---------------- 在线词典服务状态 ----------------
   * 用户最关心「在线词典到底通不通」，这里直接给出结论与解决指引。
   */
  function bindDictState() {
    const btn = u.$('#btnRecheckDict');
    if (btn) btn.addEventListener('click', updateDictState);
    updateDictState();
  }

  function updateDictState() {
    const el = u.$('#dictState');
    const tip = u.$('#serverTip');
    if (!el) return;
    if (typeof fetch !== 'function') {   // 极端环境（无 fetch）直接判为未连接
      el.textContent = '未连接 · 仅离线词库可用';
      el.className = 'dict-state warn';
      if (tip) tip.hidden = false;
      return;
    }
    el.textContent = '检测中…';
    el.className = 'dict-state';
    dict.probeProxy(true).catch(() => false).then(ok => {
      if (ok) {
        el.textContent = '已连接 · 本地服务（有道词典）';
        el.classList.add('ok');
        if (tip) tip.hidden = true;
        return;
      }
      return dict.probe(true).then(apiOk => {
        if (apiOk) {
          el.textContent = '已连接 · 在线词典 API';
          el.classList.add('ok');
          if (tip) tip.hidden = true;
        } else {
          el.textContent = '未连接 · 仅离线词库可用';
          el.classList.add('warn');
          if (tip) tip.hidden = false;
        }
      });
    }).catch(() => {
      el.textContent = '未连接 · 仅离线词库可用';
      el.className = 'dict-state warn';
      if (tip) tip.hidden = false;
    });
  }

  /* ======================================================================
   * 一、文档 / 文本导入
   * ==================================================================== */
  function bindImport() {
    els.dropZone.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', function () {
      if (this.files && this.files.length) handleFiles(this.files);
      this.value = '';
    });
    // 拖拽
    ['dragenter', 'dragover'].forEach(ev => els.dropZone.addEventListener(ev, e => {
      e.preventDefault(); els.dropZone.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => els.dropZone.addEventListener(ev, e => {
      e.preventDefault(); els.dropZone.classList.remove('over');
    }));
    els.dropZone.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    els.btnExtract.addEventListener('click', function () {
      const text = els.pasteArea.value || '';
      if (!text.trim()) { u.toast('请先粘贴文本或导入文件'); return; }
      showCandidates(importer.extractWords(text));
    });

    els.btnSaveNote.addEventListener('click', function () {
      const text = els.pasteArea.value || '';
      if (!text.trim()) { u.toast('内容不能为空'); return; }
      openNoteModal(null, text);
    });

    els.btnCandAll.addEventListener('click', () => setCandAll(true));
    els.btnCandNone.addEventListener('click', () => setCandAll(false));
    els.btnAddCand.addEventListener('click', addCandidates);
  }

  /** 处理导入的文件 */
  function handleFiles(files) {
    u.toast('正在读取文件…');
    importer.readFiles(files).then(list => {
      if (!list || !list.length) { u.toast('没有读取到可用文件'); return; }
      const text = list.map(x => x.content).join('\n\n');
      const titles = list.map(x => x.title).join('、');
      els.pasteArea.value = text;
      u.toast('已导入 ' + list.length + ' 个文件');
      const words = importer.extractWords(text);
      showCandidates(words);
      // 自动存为笔记（方便后续复用原文）
      if (list.length === 1) {
        store.addNote(list[0].title, list[0].content);
        renderNotes();
      } else {
        store.addNote(titles.slice(0, 30), text);
        renderNotes();
      }
    });
  }

  /** 渲染候选词列表 */
  function showCandidates(list) {
    candidates = list.map(c => ({
      word: c.word,
      count: c.count,
      on: !store.findByText(c.word) // 已存在的默认不勾选
    }));
    els.candCount.textContent = candidates.length + ' 个候选单词（已过滤常见词）';
    els.candArea.hidden = false;
    renderCandidates();
    if (!candidates.length) u.toast('没有识别出可加入的单词');
  }

  function renderCandidates() {
    els.candList.innerHTML = '';
    candidates.forEach(c => {
      const exist = !!store.findByText(c.word);
      const tag = u.el('span', {
        class: 'cand-word' + (c.on ? ' on' : '') + (exist ? ' exists' : ''),
        text: c.word + (c.count > 1 ? ' ×' + c.count : ''),
        title: exist ? '词库中已存在' : '点击选择'
      });
      tag.addEventListener('click', () => {
        c.on = !c.on;
        tag.classList.toggle('on', c.on);
      });
      els.candList.appendChild(tag);
    });
  }

  function setCandAll(flag) {
    candidates.forEach(c => { if (!store.findByText(c.word)) c.on = !!flag; });
    renderCandidates();
  }

  /** 批量加入生词本（联网查询释义） */
  function addCandidates() {
    const words = candidates.filter(c => c.on).map(c => c.word);
    if (!words.length) { u.toast('请至少选择一个单词'); return; }

    const body = u.el('div');
    const line = u.el('div', { class: 'loading-line', html: '<span class="spinner"></span>准备查询…' });
    body.appendChild(line);
    u.Modal.open({ title: '正在加入生词本', body: body, actions: [] });

    dict.lookupMany(words, (done, total) => {
      line.innerHTML = '<span class="spinner"></span>已处理 ' + done + ' / ' + total + ' …';
    }).then(results => {
      const addList = (results || []).filter(Boolean).map(r => ({
        word: r.word,
        phonetic: r.phonetic || '',
        property: r.property || ['other'],
        explain: r.explain || {},
        phrase: r.phrase || [],
        example: r.example || [],
        audio: r.audio || '',
        source: r.source === 'local' ? 'local' : (r.offline ? 'manual' : 'api')
      }));
      const created = store.addWords(addList);
      const offline = addList.filter(x => x.source === 'manual').length;
      u.Modal.close();
      u.toast('已加入 ' + created + ' 个新单词' + (offline ? '（' + offline + ' 个未查到释义，可手动补充）' : ''));
      // 清空已加入的候选
      candidates = candidates.filter(c => !c.on);
      if (candidates.length) renderCandidates(); else { els.candArea.hidden = true; }
      renderCatStats();
      SM.app.updateStats();
    });
  }

  /* ======================================================================
   * 二、图片 OCR 识别选词
   * ==================================================================== */
  /** 手动录入的单词（OCR 引擎不可用时的降级方案） */
  let manualWords = [];

  function bindOcr() {
    els.ocrManual = u.$('#ocrManual');
    els.ocrManualInput = u.$('#ocrManualInput');
    els.ocrManualList = u.$('#ocrManualList');
    els.ocrHint = u.$('#ocrHint');
    els.albumInput = u.$('#ocrAlbumInput');
    els.btnRetake = u.$('#btnOcrRetake');
    els.btnInvert = u.$('#btnOcrInvert');

    // 拍照：input 上带 capture="environment"，手机上直接调起后置摄像头
    u.$('#btnTakePhoto').addEventListener('click', () => els.ocrInput.click());
    // 相册：不带 capture，让用户在文件选择器里挑图（兼容从微信/QQ 保存下来的图）
    els.btnPickImage.addEventListener('click', () => els.albumInput.click());

    [els.ocrInput, els.albumInput].forEach(input => {
      input.addEventListener('change', function () {
        if (this.files && this.files[0]) runOcr(this.files[0]);
        this.value = '';
      });
    });

    // 重新拍照：丢弃当前图片与识别结果，回到最初的选择界面
    els.btnRetake.addEventListener('click', function () {
      manualWords = [];
      ocr.reset();
      ocr.setMode('select');
      Array.prototype.forEach.call(
        els.ocrModeGroup ? els.ocrModeGroup.querySelectorAll('.seg') : [],
        x => x.classList.toggle('active', x.dataset.mode === 'select')
      );
      els.ocrStage.hidden = true;
      els.ocrPlaceholder.hidden = false;
      els.ocrBoxes.innerHTML = '';
      if (els.ocrRegions) els.ocrRegions.innerHTML = '';
      els.ocrResult.innerHTML = '';
      els.ocrStatus.textContent = '正在识别…';
      els.ocrImage.removeAttribute('src');
      els.ocrManual.hidden = true;
      els.ocrManualList.innerHTML = '';
      if (els.ocrHint) els.ocrHint.hidden = true;
      const mq = u.$('#ocrMarquee');
      if (mq) mq.hidden = true;
    });

    // 缩放 / 框选模式
    const segs = els.ocrModeGroup ? els.ocrModeGroup.querySelectorAll('.seg') : [];
    Array.prototype.forEach.call(segs, s => {
      s.addEventListener('click', function () {
        Array.prototype.forEach.call(segs, x => x.classList.remove('active'));
        s.classList.add('active');
        ocr.setMode(s.dataset.mode);
      });
    });
    els.ocrZoomIn && els.ocrZoomIn.addEventListener('click', () => ocr.zoomBy(1.35));
    els.ocrZoomOut && els.ocrZoomOut.addEventListener('click', () => ocr.zoomBy(1 / 1.35));
    els.ocrZoomFit && els.ocrZoomFit.addEventListener('click', () => ocr.fitAll());
    ocr.setZoomListener(function (v) {
      if (els.ocrZoomVal) els.ocrZoomVal.textContent = Math.round((v || 1) * 100) + '%';
    });

    // 全选 / 清空：一个按钮两态。已经勾了词就变成「清空选择」，
    // 省得全选之后还要一个个点掉
    els.btnOcrAll.addEventListener('click', function () {
      if (ocr.getSelected().length) {
        ocr.clearRegions();       // 自己圈的框一起清掉
        ocr.clearSelection();
        renderOcrResult();
        u.toast('已清空所有勾选');
      } else {
        ocr.setAll(true);
        renderOcrResult();
      }
    });
    // 反选：没勾的勾上、勾上的取消
    els.btnInvert && els.btnInvert.addEventListener('click', function () {
      const n = ocr.invertSelection();
      renderOcrResult();
      u.toast('反选后共勾选 ' + n + ' 个');
    });
    els.btnOcrAdd.addEventListener('click', addOcrWords);

    // 手动录入：引擎加载失败时对照图片自己敲
    u.$('#btnOcrManualAdd').addEventListener('click', addManualWords);
    els.ocrManualInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addManualWords();
    });
  }

  /** 解析手动输入（支持空格 / 逗号 / 分号分隔多个单词） */
  function addManualWords() {
    const raw = els.ocrManualInput.value || '';
    const list = raw.split(/[\s,，;；\n]+/).map(s => dict.cleanWord(s)).filter(s => /^[a-z]{2,}$/i.test(s));
    if (!list.length) { u.toast('请输入英文单词'); return; }
    list.forEach(w => { if (manualWords.indexOf(w) < 0) manualWords.push(w); });
    els.ocrManualInput.value = '';
    els.ocrManual.hidden = false;
    renderManual();
    u.toast('已添加 ' + list.length + ' 个，点「加入生词本」入库');
  }

  function renderManual() {
    els.ocrManualList.innerHTML = '';
    manualWords.forEach((w, i) => {
      const tag = u.el('span', { class: 'cand-word on', text: w, title: '点击移除' });
      tag.addEventListener('click', () => { manualWords.splice(i, 1); renderManual(); });
      els.ocrManualList.appendChild(tag);
    });
  }

  /** 展示手动录入区（识别失败时降级） */
  function showManualFallback(msg) {
    els.ocrManual.hidden = false;
    const old = els.ocrManual.querySelector('small.hint');
    if (old) els.ocrManual.removeChild(old);
    const tip = u.el('small', { class: 'hint', text: msg });
    els.ocrManual.insertBefore(tip, els.ocrManual.firstChild);
  }

  function runOcr(file) {
    els.ocrPlaceholder.hidden = true;
    els.ocrStage.hidden = false;
    // 手动录入区始终可用：识别不好使时，用户可对照图片自己敲
    els.ocrManual.hidden = false;
    els.ocrManualList.innerHTML = '';
    els.ocrStatus.innerHTML = '<span class="spinner"></span>正在读取图片…';
    els.ocrResult.innerHTML = '';
    if (els.ocrRegions) els.ocrRegions.innerHTML = '';

    const p = ocr.recognize(file, (text, progress) => {
      els.ocrStatus.innerHTML = (progress < 1 ? '<span class="spinner"></span>' : '') + u.escapeHtml(text);
    });

    // 图片先显示出来：识别要几秒，期间用户就能先缩放/查看
    els.ocrImage.src = ocr.imgUrl;
    ocr.bindStage({
      viewport: els.ocrViewport, scene: els.ocrScene,
      marquee: u.$('#ocrMarquee'), regionLayer: els.ocrRegions
    }, onOcrChange);

    return p.then(words => {
      els.ocrImage.src = ocr.imgUrl;
      if (els.ocrHint) els.ocrHint.hidden = false;   // 提示「可以圈选了」
      ocr.renderBoxes(els.ocrViewport, els.ocrImage, onOcrChange);
      onOcrChange(ocr.getSelected());
      const q = ocr.qualityOf(ocr.state.words);
      if (!q.valid) {
        showManualFallback('图片中没识别出英文单词，可对照图片手动输入：');
      } else if (q.valid < 5 || q.single > q.valid) {
        // 识别得不好：给出具体的拍照建议，而不是让用户干瞪眼
        els.ocrStatus.innerHTML = '只认出 ' + q.valid + ' 个完整单词。建议：<b>镜头再靠近一点</b>、' +
          '只拍要背的那几行、避开反光和阴影；也可以放大图片后逐个点击单词框。';
      }
    }).catch(e => {
      els.ocrStatus.textContent = '识别失败：' + ((e && e.message) || '未知原因');
      showManualFallback('识别引擎不可用（多为网络限制）。可对照上方图片手动输入单词，或改用「导入笔记 / 文档」粘贴文本：');
    });
  }

  /** 选中变化 -> 更新底部已选词条
   *  @param {Array}  selected 已选单词文本（兼容旧调用）
   *  @param {String} msg      需要提示给用户的话 */
  function onOcrChange(selected, msg) {
    renderOcrResult();
    if (msg) u.toast(msg);
  }

  /** 底部词条：圈选出来的带 ✎ 可手改，点标签取消选择 */
  function renderOcrResult() {
    els.ocrResult.innerHTML = '';
    const items = ocr.getSelectedItems ? ocr.getSelectedItems()
      : (ocr.getSelected() || []).map(t => ({ text: t, custom: false }));
    // 按钮跟着已选数量变：有勾选时「全选」变「清空选择」；加入按钮显示个数
    if (els.btnOcrAll) els.btnOcrAll.textContent = items.length ? '清空选择' : '全选';
    if (els.btnOcrAdd) {
      els.btnOcrAdd.textContent = '加入生词本' + (items.length ? ' (' + items.length + ')' : '');
    }
    if (!items.length) {
      els.ocrResult.appendChild(u.el('small', {
        class: 'hint',
        text: '尚未选择：点图片上的单词即可打勾（右上角出 ✓），或拖出方框只圈想要的词'
      }));
      return;
    }
    items.forEach(it => {
      const tag = u.el('span', {
        class: 'cand-word on' + (it.custom ? ' from-region' : ''),
        title: it.custom ? '圈选识别：点词条取消勾选，点 ✎ 手改' : '点一下取消勾选'
      });
      tag.appendChild(u.el('b', { text: it.text }));
      tag.appendChild(u.el('i', { class: 'cand-x', text: '×' }));   // 明确的「去掉」提示
      // 整个词条（含 ×）点了都是取消勾选
      tag.addEventListener('click', () => {
        ocr.unselectWord(it.text);
        renderOcrResult();
      });
      if (it.custom) {
        const edit = u.el('i', { class: 'cand-edit', text: '✎', title: '修改识别结果' });
        edit.addEventListener('click', (ev) => {
          ev.stopPropagation();
          editRegionWord(it.text);
        });
        tag.appendChild(edit);
      }
      els.ocrResult.appendChild(tag);
    });
  }

  /** 圈选识别错了：手动改正这个单词 */
  function editRegionWord(text) {
    const input = u.el('input', {
      type: 'text', value: text, placeholder: '改成正确的英文单词',
      style: 'width:100%;padding:9px 10px;border:1px solid #dfe3e0;border-radius:9px;' +
        'font-size:14px;font-family:inherit;background:#fcfbf8;box-sizing:border-box'
    });
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocomplete', 'off');
    const body = u.el('div');
    body.appendChild(u.el('p', {
      class: 'hint', style: 'margin:0 0 8px',
      text: '识别成「' + text + '」了？对照图片改成正确的单词：'
    }));
    body.appendChild(input);
    u.Modal.open({
      title: '修改识别结果',
      body: body,
      actions: [
        { text: '取消' },
        {
          text: '保存', type: 'primary', onClick: function () {
            const v = (input.value || '').trim().toLowerCase();
            if (!/^[a-z'\- ]{2,}$/i.test(v)) { u.toast('请输入英文单词'); return; }
            ocr.updateWordText(text, v);
            renderOcrResult();
            u.toast('已改为 ' + v);
          }
        }
      ]
    });
  }

  function addOcrWords() {
    // OCR 框选的 + 手动录入的
    const words = ocr.getSelected().concat(manualWords);
    if (!words.length) { u.toast('请先在图片上点选单词，或在下方手动输入'); return; }
    const body = u.el('div');
    const line = u.el('div', { class: 'loading-line', html: '<span class="spinner"></span>准备查询…' });
    body.appendChild(line);
    u.Modal.open({ title: '正在加入生词本', body: body, actions: [] });

    dict.lookupMany(words, (done, total) => {
      line.innerHTML = '<span class="spinner"></span>已处理 ' + done + ' / ' + total + ' …';
    }).then(results => {
      const addList = (results || []).filter(Boolean).map(r => ({
        word: r.word,
        phonetic: r.phonetic || '',
        property: r.property || ['other'],
        explain: r.explain || {},
        phrase: r.phrase || [],
        example: r.example || [],
        audio: r.audio || '',
        source: r.source === 'local' ? 'local' : (r.offline ? 'manual' : 'api')
      }));
      const created = store.addWords(addList);
      u.Modal.close();
      u.toast('已加入 ' + created + ' 个单词');
      manualWords = [];
      renderManual();
      renderCatStats();
      SM.app.updateStats();
    });
  }

  /* ======================================================================
   * 三、笔记管理
   * ==================================================================== */
  function bindNotes() {
    els.btnNewNote.addEventListener('click', () => openNoteModal(null, ''));
  }

  function renderNotes() {
    const notes = store.db.notes;
    els.noteList.innerHTML = '';
    if (!notes.length) {
      els.noteList.appendChild(u.el('div', { class: 'hint', text: '还没有笔记，导入文档或新建笔记后，可随时从中提取生词。' }));
      return;
    }
    notes.forEach(n => {
      const item = u.el('div', { class: 'note-item' });
      const title = u.el('div', { class: 'note-title' });
      title.appendChild(u.el('span', { text: n.title }));
      title.appendChild(u.el('small', { text: u.timeAgo(n.updateTime || n.createTime) + ' · 关联 ' + store.noteWordCount(n.id) + ' 词' }));
      item.appendChild(title);
      item.appendChild(u.el('div', { class: 'note-prev', text: (n.content || '').slice(0, 120) || '（空白笔记）' }));

      const ops = u.el('div', { class: 'note-ops' });
      ops.appendChild(u.el('button', { text: '查看', onClick: () => openNoteView(n) }));
      ops.appendChild(u.el('button', { text: '提取生词', onClick: () => {
        const words = importer.extractWords(n.content);
        showCandidates(words);
        els.pasteArea.value = n.content;
        els.pasteArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } }));
      ops.appendChild(u.el('button', { text: '编辑', onClick: () => openNoteModal(n) }));
      ops.appendChild(u.el('button', { class: 'danger', text: '删除', onClick: () => {
        u.Modal.confirm('删除笔记', '确定删除笔记「' + n.title + '」？（单词不会被删除）', '删除').then(ok => {
          if (ok) { store.removeNote(n.id); renderNotes(); }
        });
      } }));
      item.appendChild(ops);
      els.noteList.appendChild(item);
    });
  }

  /** 新建 / 编辑笔记弹窗 */
  function openNoteModal(note, presetContent) {
    const body = u.el('div');
    const fTitle = u.el('div', { class: 'field' });
    fTitle.appendChild(u.el('label', { text: '笔记标题' }));
    const inTitle = u.el('input', { type: 'text', placeholder: '例如：Unit 3 英语笔记', value: note ? note.title : '' });
    fTitle.appendChild(inTitle);
    const fContent = u.el('div', { class: 'field' });
    fContent.appendChild(u.el('label', { text: '笔记内容' }));
    const inContent = u.el('textarea', { placeholder: '粘贴或输入英文文本…' });
    inContent.value = note ? note.content : (presetContent || '');
    fContent.appendChild(inContent);
    body.appendChild(fTitle);
    body.appendChild(fContent);
    body.appendChild(u.el('p', { class: 'hint', text: '保存后可在笔记列表一键「提取生词」' }));

    u.Modal.open({
      title: note ? '编辑笔记' : '新建笔记',
      body: body,
      actions: [
        { text: '取消' },
        {
          text: '保存', type: 'primary', onClick: () => {
            const title = inTitle.value.trim() || '未命名笔记';
            const content = inContent.value;
            if (note) store.updateNote(note.id, { title: title, content: content });
            else store.addNote(title, content);
            renderNotes();
            u.toast('笔记已保存');
          }
        }
      ]
    });
  }

  /** 查看笔记全文 */
  function openNoteView(n) {
    const body = u.el('div');
    body.appendChild(u.el('p', { class: 'hint', text: '创建于 ' + new Date(n.createTime).toLocaleString() + ' · 关联 ' + store.noteWordCount(n.id) + ' 个单词' }));
    const pre = u.el('textarea', { class: 'paste-area', readonly: 'readonly' });
    pre.value = n.content || '';
    pre.style.minHeight = '220px';
    body.appendChild(pre);
    u.Modal.open({
      title: n.title,
      body: body,
      actions: [
        {
          text: '提取生词', type: 'primary', onClick: () => {
            showCandidates(importer.extractWords(n.content));
          }
        },
        { text: '关闭' }
      ]
    });
  }

  /* ======================================================================
   * 四、词性分类统计
   * ==================================================================== */
  function renderCatStats() {
    const stats = store.posStats(false);
    els.catStats.innerHTML = '';
    if (!stats.length) {
      els.catStats.appendChild(u.el('div', { class: 'hint', text: '暂无分类数据' }));
      return;
    }
    stats.forEach(s => {
      const card = u.el('div', { class: 'cat-card', dataset: { pos: s.pos } });
      card.appendChild(u.el('b', { text: s.count }));
      card.appendChild(u.el('span', { text: s.pos + ' ' + s.cn }));
      card.addEventListener('click', () => {
        SM.app.switchPage('page-learn');
        SM.views.learn.setPos(s.pos);
        u.toast('已筛选：' + s.cn);
      });
      els.catStats.appendChild(card);
    });
  }

  /* ======================================================================
   * 五、设置与数据
   * ==================================================================== */
  function bindSettings() {
    const s = els.sets;
    const pairs = [
      [s.autoQuery, 'autoQuery'], [s.translate, 'translate'], [s.phrase, 'phrase'],
      [s.autoSpeak, 'autoSpeak'], [s.autoMask, 'autoMask']
    ];
    pairs.forEach(p => {
      const input = p[0], key = p[1];
      input.checked = !!store.getSettings()[key];
      input.addEventListener('change', function () {
        store.setSetting(key, this.checked);
        if (key === 'autoSpeak' || key === 'autoMask') SM.views.learn.syncSwitches();
        u.toast('设置已保存');
      });
    });
    s.accent.value = store.getSettings().accent || 'en-US';
    s.accent.addEventListener('change', function () { store.setSetting('accent', this.value); });

    // 发音自检：点一下就知道是「浏览器没出声」还是「根本没装英文语音包」
    const btnTest = u.$('#btnTestSpeak');
    if (btnTest) btnTest.addEventListener('click', function () {
      const tip = u.$('#speakTip');
      const d = SM.speech.diagnose ? SM.speech.diagnose() : { supported: false, voiceCount: 0, enVoiceCount: 0, enVoices: [] };
      if (tip) {
        tip.hidden = false;
        tip.innerHTML = '浏览器语音合成：' + (d.supported ? '支持' : '不支持') +
          ' · 已装音色 ' + d.voiceCount + ' 个（英文 ' + d.enVoiceCount + ' 个）' +
          (d.enVoices.length ? '<br>英文音色：' + u.escapeHtml(d.enVoices.join('、')) : '') +
          '<br>正在试听「example」…（浏览器没声会自动切换在线真人发音）';
      }
      SM.speech.speak('example', {
        onStart: function () { if (tip) tip.innerHTML += '<br><b>✓ 已出声</b>'; },
        onFail: function () {
          if (tip) tip.innerHTML += '<br><b style="color:var(--danger)">✗ 仍然没声音</b>：请确认手机没静音、音量已开，且能联网（在线真人发音需要网络）。';
        }
      });
    });

    // 导出备份
    u.$('#btnExport').addEventListener('click', function () {
      const name = '超级记忆备份_' + new Date().toISOString().slice(0, 10) + '.json';
      u.download(name, store.exportData());
      u.toast('备份已导出');
    });

    // 导入备份
    u.$('#btnImport').addEventListener('click', function () {
      const body = u.el('div');
      const f = u.el('div', { class: 'field' });
      f.appendChild(u.el('label', { text: '选择备份文件（.json）' }));
      const input = u.el('input', { type: 'file', accept: '.json' });
      f.appendChild(input);
      body.appendChild(f);
      body.appendChild(u.el('p', { class: 'hint', text: '合并导入：只补充本地没有的单词；覆盖导入：清空后写入备份。' }));
      let picked = null;
      input.addEventListener('change', function () { picked = this.files[0]; });

      u.Modal.open({
        title: '导入备份',
        body: body,
        actions: [
          { text: '取消' },
          {
            text: '合并导入', onClick: () => {
              if (!picked) { u.toast('请先选择文件'); return; }
              u.readTextFile(picked).then(txt => {
                const n = store.importData(txt, 'merge');
                u.toast('已导入 ' + n + ' 个单词');
                renderNotes(); renderCatStats(); SM.app.updateStats();
              }).catch(() => u.toast('文件格式不正确'));
            }
          },
          {
            text: '覆盖导入', type: 'danger', onClick: () => {
              if (!picked) { u.toast('请先选择文件'); return; }
              u.Modal.confirm('覆盖导入', '将清空当前所有单词和笔记，确定继续？', '覆盖').then(ok => {
                if (!ok) return;
                u.readTextFile(picked).then(txt => {
                  const n = store.importData(txt, 'replace');
                  u.toast('已恢复 ' + n + ' 个单词');
                  renderNotes(); renderCatStats(); SM.app.updateStats();
                }).catch(() => u.toast('文件格式不正确'));
              });
            }
          }
        ]
      });
    });

    // 网络诊断
    u.$('#btnDiagnose').addEventListener('click', runDiagnose);

    // 清理词典缓存
    u.$('#btnClearCache').addEventListener('click', function () {
      u.Modal.confirm('清理缓存', '将清空已缓存的 ' + dict.cacheCount() + ' 条词典数据（不影响词库）', '清理').then(ok => {
        if (!ok) return;
        dict.clearCache();
        els.cacheCount.textContent = '0';
        u.toast('缓存已清理');
      });
    });

    // 清空全部数据
    u.$('#btnReset').addEventListener('click', function () {
      u.Modal.confirm('清空数据', '将删除全部单词与笔记，且无法恢复，建议先导出备份。', '确认清空').then(ok => {
        if (!ok) return;
        store.clearAll();
        renderNotes(); renderCatStats();
        u.toast('数据已清空');
      });
    });
  }

  /** 网络诊断：逐个探测数据源，告诉用户到底是哪一环不通 */
  function runDiagnose() {
    const body = u.el('div', { class: 'diag-list' });
    body.innerHTML = '<div class="loading-line"><span class="spinner"></span>正在检测在线词典、翻译、短语与 OCR 引擎…</div>';
    u.Modal.open({ title: '网络诊断', body: body, actions: [{ text: '关闭' }] });

    dict.diagnose().then(list => {
      body.innerHTML = '';
      let okCount = 0;
      list.forEach(r => {
        if (r.ok) okCount++;
        const item = u.el('div', { class: 'diag-item' });
        const left = u.el('div');
        left.appendChild(u.el('span', { text: r.name + '　' }));
        left.appendChild(u.el('span', { class: r.ok ? 'ok' : 'bad', text: r.ok ? '✓ ' + r.msg : '✗ ' + r.msg }));
        item.appendChild(left);
        body.appendChild(item);
      });

      const dictOk = list[0] && list[0].ok;
      const ocrOk = list[3] && list[3].ok;
      const concl = u.el('div', { class: 'notice', style: 'margin-top:12px' });
      concl.innerHTML =
        '<b>结论</b>' +
        (dictOk
          ? '在线词典可用，新单词会自动拉取音标、多词性与中文释义。'
          : '在线词典不可达，已自动启用本地离线词库（' + dict.localCount() + ' 条），仍可正常查词与背诵。') +
        '<br>' +
        (ocrOk ? 'OCR 引擎 CDN 可达，图片识别可正常使用。' : 'OCR 引擎无法加载，图片识别不可用；请改用「导入笔记 / 文档」或识别区内手动录入。') +
        (location.protocol === 'file:' ? '<br>当前是 <code>file://</code> 直接打开，浏览器通常会拦截跨域请求与 Worker，建议用本地服务器方式打开页面。' : '');
      body.appendChild(concl);
    });
  }

  /** 环境提示：file:// 打开时给出明确指引 */
  function checkEnv() {
    const notice = u.$('#envNotice');
    if (location.protocol === 'file:') {
      notice.hidden = false;
      notice.innerHTML =
        '<b>当前以本地文件方式打开页面</b>' +
        '浏览器会限制跨域请求和 Worker，可能导致「在线查词 / 图片识别」失败。' +
        '建议在本目录执行 <code>npx serve</code> 或用 VS Code 的 Live Server 打开（http://localhost）。' +
        '即使完全离线，也可用内置离线词库（' + dict.localCount() + ' 条）正常背单词。';
    } else {
      notice.hidden = true;
    }
  }

  /* ---------------- 手机扫码面板 ----------------
   * 手机手输一串 IP 太痛苦，这里直接给出二维码，扫一下就打开。
   *
   * 两种运行环境：
   *  ① 公网/托管地址（https 域名） —— 当前页面地址就是入口，手机随时扫码，不用开电脑；
   *  ② 本机 localhost:8124      —— 问服务端拿局域网 IP，手机需连同一个 WiFi。
   */
  const HOST_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

  /** 判断当前是不是“只能本机访问”的运行环境 */
  function isLocalHost() {
    const h = location.hostname;
    return !h || HOST_LOCAL.test(h) || location.protocol === 'file:';
  }

  /** 拿到可以给别人扫的地址列表（异步：局域网 IP 要问服务端） */
  function selfUrls() {
    if (!isLocalHost()) return Promise.resolve([location.href]);   // 公网：直接用页面地址
    if (typeof fetch !== 'function') return Promise.resolve([]);
    return fetch('api/lan')
      .then(r => r.json())
      .then(j => (j && j.urls) || [])
      .catch(() => []);
  }

  function renderQrPanel() {
    const panel = u.$('#qrPanel');
    if (!panel) return;
    if (!window.qrcode) return;

    const CACHE_KEY = 'supermemo.lanTipClosed';
    const urlEl = u.$('#qrUrl');
    const canvasBox = u.$('#qrCanvas');
    const copyBtn = u.$('#btnCopyUrl');

    function paint(url, tip) {
      panel.hidden = false;
      if (urlEl) urlEl.textContent = url;
      if (canvasBox) canvasBox.innerHTML = renderQrSvg(url, 132);
      const small = panel.querySelector('small.hint');
      if (small && tip) small.innerHTML = tip;
      if (copyBtn) {
        const fresh = copyBtn.cloneNode(true);      // 去掉旧监听，避免重复绑定
        copyBtn.parentNode.replaceChild(fresh, copyBtn);
        fresh.addEventListener('click', function () {
          copyText(url) ? u.toast('已复制：' + url) : u.toast('复制失败，请手动选中上面的地址');
        });
      }
    }

    selfUrls().then(list => {
      if (!list.length) { panel.hidden = true; return; }
      paint(list[0], isLocalHost()
        ? '手机连同一个 WiFi 后扫码打开。'
        : '手机<b>随时扫码</b>打开（不用开电脑、不用连同一个 WiFi），建议「添加到主屏幕」。');
      localStorage.setItem(CACHE_KEY, '1');
    });
  }

  /** 把二维码渲染进任意容器（顶部 📱 弹窗用） */
  function renderQrInto(box) {
    if (!box) return;

    // 公网：永久入口，直接出码
    if (!isLocalHost()) {
      const url = location.href;
      box.innerHTML = '<div class="qr-item">' +
        '<div class="qr-canvas">' + renderQrSvg(url, 168) + '</div>' +
        '<p class="qr-url">' + u.escapeHtml(url) + '</p>' +
        '</div>' +
        '<small><b>这是公网永久地址</b>：手机随时扫码都能用，<b>不需要电脑开机</b>，也不需要连同一个 WiFi。<br>' +
        '建议用手机浏览器打开后「添加到主屏幕」，以后点桌面图标就能直接进来。</small>';
      return;
    }

    if (typeof fetch !== 'function' || !window.qrcode) {
      box.innerHTML = '<small class="hint">当前环境不支持二维码，请直接在手机浏览器输入：<br><b>' +
        u.escapeHtml(location.origin || 'http://localhost:8124') + '</b></small>';
      return;
    }
    fetch('api/lan')
      .then(r => r.json())
      .then(j => {
        const list = (j && j.urls) || [];
        if (!list.length) {
          box.innerHTML = '<small class="hint">没有检测到局域网地址，请确认电脑已连上 WiFi 或有线网络。</small>';
          return;
        }
        let html = '';
        list.forEach(addr => {
          html += '<div class="qr-item">' +
            '<div class="qr-canvas">' + renderQrSvg(addr, 150) + '</div>' +
            '<p class="qr-url">' + u.escapeHtml(addr) + '</p>' +
            '</div>';
        });
        html += '<small>手机连同一个 WiFi 后扫码即可打开。建议用手机浏览器打开后选择「添加到主屏幕」，' +
          '之后点桌面图标就能直接进来。换网络后本机 IP 可能变，重新点这个按钮扫一次即可。</small>';
        box.innerHTML = html;
      })
      .catch(() => {
        box.innerHTML = '<small class="hint">获取本机地址失败。请确认页面是通过 http://localhost:8124 打开的（而不是双击 index.html 文件）。</small>';
      });
  }

  /** 生成二维码 SVG：不依赖 canvas，手机上放大也清晰 */
  function renderQrSvg(text, px) {
    const lib = window.qrcode;
    if (!lib) return '<small class="hint">二维码组件未加载</small>';
    try {
      const qr = lib(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let rects = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) rects += '<rect x="' + c + '" y="' + r + '" width="1" height="1"/>';
        }
      }
      return '<svg viewBox="-2 -2 ' + (n + 4) + ' ' + (n + 4) + '" width="' + px + '" height="' + px + '" ' +
        'shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="-2" y="-2" width="' + (n + 4) + '" height="' + (n + 4) + '" fill="#fff"/>' +
        '<g fill="#2f6b52">' + rects + '</g></svg>';
    } catch (e) {
      return '<small class="hint">二维码生成失败：' + u.escapeHtml(e.message) + '</small>';
    }
  }

  /** 复制文本到剪贴板（优先用新 API，失败降级到 execCommand） */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 继续降级 */ }
    try {
      const ta = u.el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /** 供外部（生词页开关）同步设置 UI */
  function syncSettings() {
    const st = store.getSettings();
    els.sets.autoSpeak.checked = !!st.autoSpeak;
    els.sets.autoMask.checked = !!st.autoMask;
  }

  /** 数据变化时刷新本页相关区块 */
  function refresh() {
    renderNotes();
    renderCatStats();
    els.cacheCount.textContent = dict.cacheCount();
    if (typeof renderSyncState === 'function') renderSyncState();
  }

  /* ======================================================================
   * 云同步面板
   * 手机和电脑各在一处，点一下「连接」后就共用同一份生词本。
   * ====================================================================== */
  const sb = {};   // sync box 元素引用

  function bindSync() {
    sb.tip = u.$('#syncTip');
    sb.desc = u.$('#syncDesc');
    sb.setup = u.$('#syncSetup');
    sb.ready = u.$('#syncReady');
    sb.token = u.$('#syncToken');
    sb.btnConnect = u.$('#btnSyncConnect');
    sb.btnPair = u.$('#btnSyncPair');
    sb.btnNow = u.$('#btnSyncNow');
    sb.btnQr = u.$('#btnSyncQr');
    sb.btnOff = u.$('#btnSyncOff');
    sb.auto = u.$('#setSyncAuto');
    sb.local = u.$('#setSyncLocal');
    if (!sb.desc || !SM.sync) return;

    sb.btnConnect.addEventListener('click', onConnectClick);
    sb.btnPair.addEventListener('click', openPairModalInput);
    sb.btnNow.addEventListener('click', function () {
      u.toast('正在同步…');
      renderSyncState('syncing');
      SM.sync.sync().then(() => renderSyncState());
    });
    sb.btnQr.addEventListener('click', openQrModal);
    sb.btnOff.addEventListener('click', function () {
      u.Modal.confirm('断开云同步', '断开后这台设备不再自动同步（本地数据保留，云端数据也不删除）。确定断开？', '断开')
        .then(ok => {
          if (!ok) return;
          SM.sync.reset();
          renderSyncState();
          u.toast('已断开云同步');
        });
    });
    sb.auto.addEventListener('change', function () {
      SM.sync.setAuto(this.checked);
      u.toast(this.checked ? '已开启自动同步' : '已关闭自动同步');
    });
    sb.local.addEventListener('change', function () {
      SM.sync.setMode(this.checked ? 'local' : 'gist');
      renderSyncState();
      if (this.checked) {
        u.toast('已切换到局域网同步');
        SM.sync.sync();
      }
    });
    sb.token && sb.token.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') onConnectClick();
    });

    // 同步过程中实时更新状态
    SM.sync.onStateChange(() => renderSyncState());

    renderSyncState();
    if (SM.sync.isEnabled()) SM.sync.startAuto();
  }

  /** 连接（或提示如何获取令牌） */
  function onConnectClick() {
    const token = (sb.token.value || '').trim();
    if (!token) { openTokenGuide(); return; }
    if (!/^gh[pousr]_[A-Za-z0-9]{20,}$|^[0-9a-f]{40}$/i.test(token)) {
      u.toast('这串字符不像 GitHub 令牌，通常是 ghp_ 开头的那串', 3600);
      return;
    }
    btnWorking(sb.btnConnect, true, '连接中…');
    SM.sync.configure(token, '', sb.local.checked ? 'local' : 'gist');
    SM.sync.sync().then(r => {
      btnWorking(sb.btnConnect, false, '连接云同步');
      if (r && r.failed) { u.toast('连接失败：' + r.error, 4000); return; }
      u.toast('云同步已开启 🎉');
      sb.token.value = '';
      SM.sync.startAuto();
      renderSyncState();
    }).catch(e => {
      btnWorking(sb.btnConnect, false, '连接云同步');
      u.toast('连接失败：' + ((e && e.message) || e), 4000);
    });
  }

  function btnWorking(btn, busy, text) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = text;
  }

  /** 令牌获取引导 */
  function openTokenGuide() {
    const body = u.el('div');
    body.appendChild(u.el('p', { class: 'hint', text: '还没令牌？跟着下面做，大约 30 秒：' }));
    const steps = u.el('ol', { class: 'sync-steps' });
    [
      '电脑打开 github.com 登录（没有账号就注册一个，免费）',
      '点右上角头像 → Settings → Developer settings',
      'Personal access tokens → Tokens (classic) → Generate new token (classic)',
      '备注填「超级记忆」，勾选 gist 这一项就够了',
      '点 Generate，复制生成的那串字符（只显示一次）',
      '回到本页面粘贴，点「连接云同步」'
    ].forEach(s => steps.appendChild(u.el('li', { text: s })));
    body.appendChild(steps);
    body.appendChild(u.el('p', {
      class: 'hint',
      text: '令牌只存在这台设备上，仅用于读写你自己那个私有数据空间，不会发给任何第三方。'
    }));
    const pv = u.el('input', { class: 'field-input', type: 'password', placeholder: '也可以直接在这里粘贴令牌' });
    body.appendChild(pv);
    u.Modal.open({
      title: '获取 GitHub 令牌',
      body: body,
      actions: [
        { text: '去 GitHub 注册/登录', onClick: () => window.open('https://github.com/settings/tokens', '_blank') },
        { text: '取消' },
        {
          text: '直接连接', type: 'primary', onClick: () => {
            const t = (pv.value || '').trim();
            if (!t) { u.toast('请先粘贴令牌'); return false; }
            sb.token.value = t;
            u.Modal.close();
            onConnectClick();
          }
        }
      ]
    });
  }

  /** 用配对码加入另一台设备（生成配对码看「配对二维码」） */
  function openQrModal() {
    let code = '';
    try { code = SM.sync.makeCode(); } catch (e) { }
    if (!code) { u.toast('还没连接云端，先点「连接云同步」'); return; }
    const body = u.el('div');
    body.appendChild(u.el('p', { class: 'hint', text: '用另一台设备的浏览器扫描（或手机相机扫描后在浏览器打开）：' }));
    const box = u.el('div', { class: 'qr-canvas', style: 'margin:0 auto;width:fit-content' });
    box.innerHTML = renderQrSvg(code, 176);
    body.appendChild(box);
    const ta = u.el('textarea', { class: 'sync-paircode', readonly: 'readonly', rows: 3 });
    ta.value = code;
    body.appendChild(ta);
    body.appendChild(u.el('p', { class: 'hint', text: '扫不出来就用上面这串配对码手动粘贴。' }));
    u.Modal.open({
      title: '配对二维码',
      body: body,
      actions: [
        { text: '复制配对码', onClick: () => { copyText(code) ? u.toast('已复制') : u.toast('复制失败'); return false; } },
        { text: '关闭' }
      ]
    });
  }

  /** 用配对码加入 */
  function openPairModalInput() {
    const body = u.el('div');
    body.appendChild(u.el('p', { class: 'hint', text: '把另一台设备上生成的配对码粘贴到这里：' }));
    const ta = u.el('textarea', { class: 'paste-area', placeholder: 'SM1:...', rows: 3 });
    ta.style.minHeight = '110px';
    ta.style.fontSize = '11px';
    body.appendChild(ta);
    u.Modal.open({
      title: '用配对码加入',
      body: body,
      actions: [
        { text: '取消' },
        {
          text: '加入', type: 'primary', onClick: () => {
            const code = (ta.value || '').trim();
            if (!code) { u.toast('请先粘贴配对码'); return false; }
            try {
              SM.sync.applyCode(code);
            } catch (e) {
              u.toast('配对码无效：' + e.message, 3600);
              return false;
            }
            u.Modal.close();
            u.toast('正在同步…');
            SM.sync.sync().then(r => {
              if (r && r.failed) u.toast('同步失败：' + r.error, 4000);
              else u.toast('已加入并同步 🎉');
              SM.sync.startAuto();
              renderSyncState();
            });
          }
        }
      ]
    });
  }
  /**
   * 支持「一键配对链接」：部署完成后会给出一个带 #sync= 的网址，
   * 设备打开它就自动配好云同步，不用手抄配对码。
   */
  function applyPairLink() {
    if (!SM.sync) return;
    try {
      const m = /(?:#|\?)(?:sync|pair)=([^&]+)/.exec(location.hash || location.search || '');
      if (!m) return;
      const code = decodeURIComponent(m[1]);
      SM.sync.applyCode(code);
      u.toast('正在连接云端…');
      SM.sync.sync().then(r => {
        if (r && r.failed) u.toast('连接失败：' + r.error, 4000);
        else u.toast('云同步已开启 🎉');
        SM.sync.startAuto();
        renderSyncState();
      });
      // 把凭据从地址栏抹掉，避免误分享或存进历史记录
      history.replaceState(null, '', location.pathname + location.search.replace(/[?&]pair=[^&]*/, ''));
    } catch (e) {
      console.warn('[sync] 配对链接无效', e);
    }
  }

  /** 相对时间 */
  function fmtAgo(t) {
    if (!t) return '从未同步';
    const d = Date.now() - t;
    if (d < 60 * 1000) return '刚刚';
    if (d < 3600 * 1000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  /** 刷新同步面板显示 */
  function renderSyncState(over) {
    if (!sb.desc || !SM.sync) return;
    const s = SM.sync.status();
    const cfg = SM.sync.getConfig();
    sb.setup.hidden = s.enabled;
    sb.ready.hidden = !s.enabled;

    if (!s.enabled) {
      sb.tip.textContent = '未开启';
      sb.desc.innerHTML = '开启后，手机和电脑背的是<b>同一份生词本</b>：这边加的词、标熟的词，另一边自动跟上。';
      if (sb.local) sb.local.checked = cfg.mode === 'local';
      return;
    }

    const busy = over === 'syncing';
    sb.tip.textContent = busy ? '同步中…' : fmtAgo(s.lastSync);
    const dot = busy ? 'busy' : (s.error ? 'err' : 'ok');
    const total = s.words || 0;
    let line = '<span class="sync-dot ' + dot + '"></span><span>' +
      u.escapeHtml(s.transportLabel) + ' · 已同步 <b>' + total + '</b> 个单词 · ' + fmtAgo(s.lastSync) + '</span>';
    if (s.error) {
      line += '<div class="sync-err">上次出错：' + u.escapeHtml(s.error) + '</div>';
    }
    sb.desc.innerHTML = line;
    if (sb.auto) sb.auto.checked = cfg.auto !== false;
    if (sb.local) sb.local.checked = cfg.mode === 'local';
  }

  SM.views = SM.views || {};
  SM.views.tools = { init, refresh, syncSettings, showCandidates, renderNotes, renderQrInto, renderSyncState };
})(window.SM);
