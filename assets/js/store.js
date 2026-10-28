/* ==========================================================================
 * store.js —— 本地持久化数据层（localStorage）
 *
 * 单词表 word 结构（严格对齐需求字段）：
 *   id          唯一标识
 *   word        英文单词
 *   phonetic    国际音标
 *   property    ['n.','v.']                全部词性（不省略）
 *   explain     { 'n.':['释义1','释义2'], 'v.':[...] }   每个词性对应多条释义
 *   phrase      ['abandon oneself to 沉溺于']            常考短语 / 固定搭配
 *   example     ['例句1']                                 例句（辅助记忆）
 *   isMaster    false / true               是否熟记
 *   createTime  添加时间戳
 *   masterTime  熟记时间戳
 *   noteId      归属笔记 ID（可为空）
 *   source      'manual' | 'api' | 'import' | 'ocr'
 *
 * 笔记表 note 结构：id / title / content / createTime / updateTime
 * ========================================================================== */
(function (SM) {
  'use strict';

  const KEY_DB = 'supermemo.db.v1';
  const u = SM.utils;

  const DEFAULT_SETTINGS = {
    autoQuery: true,    // 联网自动查询
    translate: true,    // 自动翻译中文
    phrase: true,       // 查询动词搭配
    autoSpeak: false,   // 切换单词自动朗读
    autoMask: true,     // 默认遮罩释义
    accent: 'en-US'     // 发音口音
  };

  /* ---------------- 内存中的数据 ----------------
   * deleted：删除墓碑 { id: 删除时间戳 }
   * 云同步必须有它——否则 A 设备删掉的词，会被 B 设备的旧版本重新合并回来。
   */
  let DB = { version: 1, words: [], notes: [], settings: Object.assign({}, DEFAULT_SETTINGS), deleted: {} };
  const listeners = [];

  /** 墓碑保留时长：超过这个时间的墓碑可以安全清理（所有设备早就同步过一遍了） */
  const TOMB_TTL = 30 * 24 * 3600 * 1000;

  /* ---------------- 读写持久化 ---------------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY_DB);
      if (raw) {
        const data = JSON.parse(raw);
        DB.words = Array.isArray(data.words) ? data.words : [];
        DB.notes = Array.isArray(data.notes) ? data.notes : [];
        DB.deleted = (data.deleted && typeof data.deleted === 'object') ? data.deleted : {};
        DB.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
      }
    } catch (e) {
      console.warn('[store] 数据读取失败，已重置为空白库', e);
    }
    return DB;
  }

  /** 记录一次删除（供云同步判断"这条记录在别处已被删掉"） */
  function markDeleted(id) {
    if (!id) return;
    DB.deleted[id] = Date.now();
  }

  /** 清理过期墓碑，避免无限增长 */
  function purgeDeleted() {
    if (!DB.deleted) return 0;
    const now = Date.now();
    let n = 0;
    Object.keys(DB.deleted).forEach(id => {
      if (now - DB.deleted[id] > TOMB_TTL) { delete DB.deleted[id]; n++; }
    });
    return n;
  }

  function save() {
    try {
      localStorage.setItem(KEY_DB, JSON.stringify(DB));
    } catch (e) {
      console.error('[store] 保存失败（可能超出容量）', e);
      u.toast('本地存储空间不足，请清理缓存');
    }
  }

  /** 数据变化时通知订阅者（各页面刷新 UI） */
  function emit(reason) {
    save();
    listeners.forEach(fn => { try { fn(reason); } catch (e) { console.error(e); } });
  }
  function subscribe(fn) { listeners.push(fn); }

  /* ---------------- 单词 CRUD ---------------- */

  /** 归一化用于查找的 key */
  function keyOf(word) { return String(word || '').trim().toLowerCase(); }

  /** 按单词文本查找（忽略大小写） */
  function findByText(word) {
    const k = keyOf(word);
    return DB.words.find(w => keyOf(w.word) === k) || null;
  }
  function getById(id) { return DB.words.find(w => w.id === id) || null; }

  /** 规范化一条单词数据（补全字段） */
  function normalize(data) {
    const now = Date.now();
    const property = (data.property || []).filter(Boolean).map(u.normPos);
    const explain = data.explain || {};
    // 保证 explain 里出现的词性都在 property 中
    Object.keys(explain).forEach(p => {
      const np = u.normPos(p);
      if (property.indexOf(np) < 0) property.push(np);
      if (np !== p) { explain[np] = explain[np] || explain[p]; }
    });
    return {
      id: data.id || u.uid('w'),
      word: String(data.word || '').trim(),
      phonetic: data.phonetic || '',
      audio: data.audio || '',                 // 在线真人发音地址（可选）
      property: property.length ? property : ['other'],
      explain: explain,
      phrase: Array.isArray(data.phrase) ? data.phrase : [],
      example: Array.isArray(data.example) ? data.example : [],
      isMaster: !!data.isMaster,
      createTime: data.createTime || now,
      masterTime: data.masterTime || 0,
      noteId: data.noteId || '',
      source: data.source || 'manual',
      reviewCount: data.reviewCount || 0,
      lastReview: data.lastReview || 0,
      updatedAt: data.updatedAt || now      // 最后修改时间（云同步冲突判定用）
    };
  }

  /**
   * 新增单词；如已存在则合并（补充缺失的释义/短语），返回 {word, created}
   */
  function addWord(data) {
    const item = normalize(data);
    if (!item.word) return null;
    const exist = findByText(item.word);
    if (exist) {
      // 合并：补全音标、词性、释义、短语
      if (!exist.phonetic && item.phonetic) exist.phonetic = item.phonetic;
      const merged = Object.assign({}, exist.explain);
      Object.keys(item.explain || {}).forEach(p => {
        if (!merged[p]) merged[p] = item.explain[p];
      });
      exist.explain = merged;
      item.property.forEach(p => { if (exist.property.indexOf(p) < 0) exist.property.push(p); });
      (item.phrase || []).forEach(ph => { if (exist.phrase.indexOf(ph) < 0) exist.phrase.push(ph); });
      (item.example || []).forEach(ex => { if (exist.example.indexOf(ex) < 0) exist.example.push(ex); });
      if (item.noteId && !exist.noteId) exist.noteId = item.noteId;
      // 补全新问答缺席的空字段（例如初次导入时没有音标，联网后又查到了）
      if (!exist.audio && item.audio) exist.audio = item.audio;
      exist.updatedAt = Date.now();
      // 这条记录曾被删过（墓碑），现在又加回来了 -> 撤销墓碑
      if (DB.deleted && DB.deleted[exist.id]) delete DB.deleted[exist.id];
      emit('word:merge');
      return { word: exist, created: false };
    }
    DB.words.push(item);
    emit('word:add');
    return { word: item, created: true };
  }

  /** 批量新增（内部调用 addWord，最后统一 emit） */
  function addWords(list) {
    let created = 0;
    list.forEach(d => {
      const r = addWord(d);
      if (r && r.created) created++;
    });
    emit('word:batch');
    return created;
  }

  function updateWord(id, patch) {
    const w = getById(id);
    if (!w) return null;
    Object.assign(w, patch);
    w.updatedAt = Date.now();
    emit('word:update');
    return w;
  }

  function removeWord(id) {
    const i = DB.words.findIndex(w => w.id === id);
    if (i >= 0) {
      markDeleted(DB.words[i].id);
      DB.words.splice(i, 1);
      emit('word:remove');
      return true;
    }
    return false;
  }

  /** 标记熟记 / 取消熟记（生词本 <=> 熟词库 流转） */
  function setMaster(id, isMaster) {
    const w = getById(id);
    if (!w) return null;
    w.isMaster = !!isMaster;
    w.masterTime = isMaster ? Date.now() : 0;
    w.updatedAt = Date.now();
    emit('word:master');
    return w;
  }

  /** 记录一次复习 */
  function markReview(id) {
    const w = getById(id);
    if (w) { w.reviewCount = (w.reviewCount || 0) + 1; w.lastReview = Date.now(); w.updatedAt = Date.now(); }
  }

  /* ---------------- 查询 / 筛选 ---------------- */
  /**
   * @param {Object} opt {master:Boolean, pos:String, keyword:String}
   */
  function listWords(opt) {
    opt = opt || {};
    const kw = (opt.keyword || '').trim().toLowerCase();
    return DB.words.filter(w => {
      if (opt.master === true && !w.isMaster) return false;
      if (opt.master === false && w.isMaster) return false;
      if (opt.pos && opt.pos !== 'all' && w.property.indexOf(opt.pos) < 0) return false;
      if (opt.noteId && w.noteId !== opt.noteId) return false;
      if (kw) {
        const inWord = w.word.toLowerCase().indexOf(kw) >= 0;
        let inExplain = false;
        Object.keys(w.explain || {}).forEach(p => {
          (w.explain[p] || []).forEach(d => { if (String(d).toLowerCase().indexOf(kw) >= 0) inExplain = true; });
        });
        const inPhrase = (w.phrase || []).some(p => String(p).toLowerCase().indexOf(kw) >= 0);
        if (!inWord && !inExplain && !inPhrase) return false;
      }
      return true;
    }).sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  }

  /** 全部词性及其数量（用于筛选 chips 与分类统计） */
  function posStats(master) {
    const map = {};
    DB.words.forEach(w => {
      if (master === true && !w.isMaster) return;
      if (master === false && w.isMaster) return;
      (w.property || ['other']).forEach(p => { map[p] = (map[p] || 0) + 1; });
    });
    return Object.keys(map)
      .sort((a, b) => map[b] - map[a])
      .map(p => ({ pos: p, cn: u.posCn(p), count: map[p] }));
  }

  function stats() {
    let master = 0, today = 0;
    DB.words.forEach(w => {
      if (w.isMaster) master++;
      if (u.isToday(w.createTime)) today++;
    });
    return {
      total: DB.words.length,
      newCount: DB.words.length - master,
      master: master,
      today: today,
      notes: DB.notes.length
    };
  }

  /* ---------------- 笔记 CRUD ---------------- */
  function addNote(title, content) {
    const note = {
      id: u.uid('n'),
      title: title || ('笔记 ' + (DB.notes.length + 1)),
      content: content || '',
      createTime: Date.now(),
      updateTime: Date.now(),
      updatedAt: Date.now()
    };
    if (DB.deleted && DB.deleted[note.id]) delete DB.deleted[note.id];
    DB.notes.unshift(note);
    emit('note:add');
    return note;
  }
  function updateNote(id, patch) {
    const n = DB.notes.find(x => x.id === id);
    if (!n) return null;
    Object.assign(n, patch);
    n.updateTime = Date.now();
    n.updatedAt = Date.now();
    emit('note:update');
    return n;
  }
  function removeNote(id) {
    const i = DB.notes.findIndex(x => x.id === id);
    if (i < 0) return false;
    markDeleted(DB.notes[i].id);
    DB.notes.splice(i, 1);
    // 笔记删除后，其下单词解绑（不删除单词本身）
    DB.words.forEach(w => { if (w.noteId === id) w.noteId = ''; });
    emit('note:remove');
    return true;
  }
  function getNote(id) { return DB.notes.find(x => x.id === id) || null; }

  /** 笔记关联单词数 */
  function noteWordCount(id) {
    return DB.words.filter(w => w.noteId === id).length;
  }

  /* ---------------- 设置 ---------------- */
  function getSettings() { return DB.settings; }
  function setSetting(k, v) { DB.settings[k] = v; emit('settings'); }

  /* ---------------- 备份 / 恢复 / 清理 ---------------- */
  function exportData() {
    return JSON.stringify({ version: 1, exportTime: Date.now(), words: DB.words, notes: DB.notes, settings: DB.settings }, null, 2);
  }

  /** 导入备份：mode = 'merge'(合并) | 'replace'(覆盖) */
  function importData(json, mode) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.words)) throw new Error('备份文件格式不正确');
    if (mode === 'replace') {
      DB.words = data.words.map(normalize);
      DB.notes = Array.isArray(data.notes) ? data.notes : [];
      // 覆盖式导入 = 全新起点，旧墓碑失去意义
      DB.deleted = {};
    } else {
      data.words.forEach(w => {
        const exist = findByText(w.word);
        if (!exist) DB.words.push(normalize(w));
      });
      (data.notes || []).forEach(n => {
        if (!DB.notes.some(x => x.id === n.id)) DB.notes.push(n);
      });
    }
    emit('data:import');
    return data.words.length;
  }

  /** 清空全部单词与笔记
   *  ⚠️ 必须给每条记录打墓碑，否则清空操作同步到别的设备后，
   *     对方的老数据会在合并时被当成"新记录"重新写回来。
   */
  function clearAll() {
    DB.words.forEach(w => markDeleted(w.id));
    DB.notes.forEach(n => markDeleted(n.id));
    DB.words = [];
    DB.notes = [];
    emit('data:clear');
  }

  SM.store = {
    load, save, subscribe, emit,
    get db() { return DB; },
    // 单词
    addWord, addWords, updateWord, removeWord, setMaster, markReview,
    getById, findByText, listWords, posStats, stats, normalize, keyOf,
    // 同步支持（墓碑：记录"这条已被删除"，否则删除无法在多设备间传播）
    markDeleted, purgeDeleted,
    // 笔记
    addNote, updateNote, removeNote, getNote, noteWordCount,
    // 设置
    getSettings, setSetting, DEFAULT_SETTINGS,
    // 数据
    exportData, importData, clearAll
  };
})(window.SM);
