/* ==========================================================================
 * sync.js —— 跨设备云同步
 *
 * 目标：手机和电脑背的是同一份生词本，改哪边另一边都能跟上。
 *
 * 设计要点
 *   1) 存储后端抽象成 transport，目前两种：
 *      - gist ：GitHub Gist（默认，公网可用，电脑关机也能同步）
 *      - local：server.js 的 /api/sync（同一 WiFi 下的局域网降级方案）
 *   2) 合并策略 = LWW（最后修改胜出）+ 墓碑
 *      - 每条记录带 updatedAt，新的覆盖旧的
 *      - 删除不真的"消失"，而是记墓碑 {id: 删除时间}。
 *        否则 A 设备删掉的词，会被 B 设备推送的旧版本重新塞回来。
 *   3) settings（界面偏好）不参与同步，避免一台设备的设置被另一台覆盖。
 *   4) 全程离线可用：同步失败只影响"同步"，本地增删改查照常。
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils;

  const KEY_CFG = 'supermemo.sync.cfg.v1';
  const KEY_STATE = 'supermemo.sync.state.v1';
  const FILE = 'supermemo-data.json';
  const GH_API = 'https://api.github.com';

  /* ---------------- 配置 / 状态持久化 ---------------- */
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(KEY_CFG) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY_STATE) || '{}') || {}; }
    catch (e) { return {}; }
  }
  let cfg = loadCfg();
  let st = loadState();

  function saveCfg() {
    try { localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); } catch (e) { }
  }
  function saveState() {
    try { localStorage.setItem(KEY_STATE, JSON.stringify(st)); } catch (e) { }
  }

  /* ---------------- 状态 ---------------- */
  let busy = false;        // 正在同步，避免并发
  let applying = false;    // 正在把远端结果写回本地（此时不要再触发自动推送）
  let timer = null;        // 定时拉取
  let pending = null;      // debounce 待推送
  const listeners = [];

  function setState(patch) {
    Object.assign(st, patch);
    saveState();
    listeners.forEach(fn => { try { fn(st); } catch (e) { console.error(e); } });
  }
  function onStateChange(fn) { listeners.push(fn); return fn; }

  /* ---------------- HTTP 基础 ---------------- */
  function httpGet(url, opts) {
    opts = opts || {};
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), opts.timeout || 20000);
    return fetch(url, Object.assign({}, opts.fetch || {}, ctl ? { signal: ctl.signal } : {}))
      .then(r => { clearTimeout(t); return r; })
      .catch(e => { clearTimeout(t); throw e; });
  }

  /** GitHub API 请求；把常见错误翻译成人话 */
  function gh(path, opt) {
    opt = opt || {};
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
    if (opt.body) headers['Content-Type'] = 'application/json';

    return httpGet(GH_API + path, {
      fetch: { method: opt.method || 'GET', headers: headers, body: opt.body ? JSON.stringify(opt.body) : undefined },
      timeout: opt.timeout || 25000
    }).then(r => {
      if (r.status === 401) { const e = new Error('GitHub 拒绝了这次请求：令牌无效或已过期'); e.code = 'TOKEN_INVALID'; throw e; }
      if (r.status === 403 || r.status === 429) { const e = new Error('GitHub 接口限流了（429/403），稍等几分钟再试'); e.code = 'RATE_LIMIT'; throw e; }
      if (r.status === 404) { const e = new Error('找不到这个云端空间（Gist 已被删除或令牌无权访问）'); e.code = 'NOT_FOUND'; throw e; }
      if (!r.ok) { const e = new Error('云端返回异常 HTTP ' + r.status); e.code = 'HTTP'; throw e; }
      if (r.status === 204) return null;
      return r.json();
    });
  }

  function apiUrl(p) {
    try { return new URL(p, location.href).toString(); } catch (e) { return p; }
  }

  /* ---------------- transport：GitHub Gist ---------------- */
  const gistTransport = {
    name: 'gist',
    label: 'GitHub 云',

    /** 读取云端文档；没有则返回 null */
    load: function () {
      if (!cfg.gistId) return Promise.resolve(null);
      return gh('/gists/' + encodeURIComponent(cfg.gistId))
        .then(g => {
          const f = g && g.files && g.files[FILE];
          if (!f) return null;
          // ⚠️ 内容超过 1MB 时 Gist API 会截断 content，必须走 raw_url 取全量
          if (f.truncated && f.raw_url) {
            return httpGet(f.raw_url, { timeout: 30000 }).then(r => r.text()).then(parseDoc);
          }
          return parseDoc(f.content);
        })
        .catch(e => {
          if (e.code === 'NOT_FOUND') return null;   // 空间没了就当空数据，稍后会自动重建
          throw e;
        });
    },

    /** 写入云端文档 */
    save: function (doc) {
      const text = JSON.stringify(doc);
      const body = { files: {} };
      body.files[FILE] = { content: text };

      if (!cfg.gistId) {
        // 第一次使用：自动建一个私有空间
        body.description = '超级记忆 · 生词本云同步数据';
        body.public = false;
        return gh('/gists', { method: 'POST', body: body })
          .then(g => {
            cfg.gistId = g.id;
            saveCfg();
            return doc;
          });
      }
      return gh('/gists/' + encodeURIComponent(cfg.gistId), { method: 'PATCH', body: body }).then(() => doc);
    }
  };

  /**
   * 解析云端文档
   * ⚠️ 入参可能是字符串，也可能是已经 parse 过的对象：
   *   两个 transport 一个给文本（Gist）、一个给对象（本地 JSON 接口）。
   *   早期版本只处理字符串，对象会被 JSON.parse("[object Object]") 打成 null，
   *   后果是「远端永远读不出来 -> 用本地空数据覆盖云端」，非常危险。
   */
  function parseDoc(text) {
    if (!text) return null;
    if (typeof text === 'object') {
      return (Array.isArray(text) || !text.words) && !text.deleted ? null : text;
    }
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object') return null;
      return d;
    } catch (e) { return null; }
  }

  /* ---------------- transport：本地 server.js（局域网） ---------------- */
  const localTransport = {
    name: 'local',
    label: '局域网服务',
    load: function () {
      return httpGet(apiUrl('api/sync'), { timeout: 10000 })
        .then(r => { if (!r.ok) return null; return r.json(); })
        .catch(() => null);
    },
    save: function (doc) {
      return httpGet(apiUrl('api/sync'), {
        fetch: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) },
        timeout: 15000
      }).then(r => { if (!r.ok) throw new Error('本地服务返回 HTTP ' + r.status); return doc; });
    }
  };

  function transport() {
    return cfg.mode === 'local' ? localTransport : gistTransport;
  }

  /* ---------------- 文档组装 ---------------- */
  /** 本地 -> 待同步文档（不含 settings：界面偏好不该跨设备打架） */
  function docFromLocal() {
    const db = SM.store.db;
    return {
      schema: 1,
      updatedAt: Date.now(),
      device: cfg.device || 'unknown',
      words: JSON.parse(JSON.stringify(db.words || [])),
      notes: JSON.parse(JSON.stringify(db.notes || [])),
      deleted: JSON.parse(JSON.stringify(db.deleted || {}))
    };
  }

  /* ---------------- 合并算法 ---------------- */
  function clampTime(t) { return typeof t === 'number' && t > 0 ? t : 0; }

  /**
   * 合并两个列表（按 id，LWW + 墓碑）
   * @param {Array}  la 本地列表
   * @param {Array}  lb 远端列表
   * @param {Object} ta 本地墓碑
   * @param {Object} tb 远端墓碑
   * @param {Object} tombsOut 合并后的墓碑（会原地写入）
   * @param {Function} fill 空字段互补函数
   */
  function mergeList(la, lb, ta, tb, tombsOut, fill) {
    const idx = {};       // id -> {rec, at}
    const keepGaps = {};  // id -> 落败的一方，用于互补补全

    function consider(rec) {
      if (!rec || !rec.id) return;
      const at = clampTime(rec.updatedAt);
      const cur = idx[rec.id];
      if (!cur) { idx[rec.id] = { rec: rec, at: at }; return; }
      if (at > cur.at) { keepGaps[rec.id] = cur.rec; idx[rec.id] = { rec: rec, at: at }; }
      else if (at < cur.at) { keepGaps[rec.id] = rec; }
      else keepGaps[rec.id] = keepGaps[rec.id] || rec;   // 时间戳相同：互为补充
    }

    (la || []).forEach(consider);
    (lb || []).forEach(consider);

    // 墓碑合并：任一侧删过就记下来，取较晚的时间
    Object.keys(ta || {}).forEach(id => { tombsOut[id] = Math.max(tombsOut[id] || 0, clampTime(ta[id])); });
    Object.keys(tb || {}).forEach(id => { tombsOut[id] = Math.max(tombsOut[id] || 0, clampTime(tb[id])); });

    const out = [];
    Object.keys(idx).forEach(id => {
      const entry = idx[id];
      const tomb = tombsOut[id] || 0;
      if (tomb && clampTime(entry.at) <= tomb) { return; }   // 删除更晚 -> 保持删除
      if (tomb) delete tombsOut[id];                         // 删除后又被改过 -> 复活
      const loser = keepGaps[id];
      out.push(loser ? fill(entry.rec, loser) : entry.rec);
    });
    return out;
  }

  /** 用落败方的非空字段补齐胜方（避免设备间互相"洗掉"音标/释义） */
  function fillWord(win, lose) {
    const w = Object.assign({}, win);
    if (!w.word && lose.word) w.word = lose.word;
    if (!w.phonetic && lose.phonetic) w.phonetic = lose.phonetic;
    if (!w.audio && lose.audio) w.audio = lose.audio;
    if (!w.noteId && lose.noteId) w.noteId = lose.noteId;
    if (!w.source) w.source = lose.source;

    const props = (w.property || []).slice();
    (lose.property || []).forEach(p => { if (props.indexOf(p) < 0) props.push(p); });
    w.property = props;

    const ex = Object.assign({}, w.explain || {});
    Object.keys(lose.explain || {}).forEach(p => {
      if (!ex[p] || !ex[p].length) ex[p] = lose.explain[p];
    });
    w.explain = ex;

    ['phrase', 'example'].forEach(k => {
      const arr = (w[k] || []).slice();
      (lose[k] || []).forEach(x => { if (arr.indexOf(x) < 0) arr.push(x); });
      w[k] = arr;
    });

    // 复习次数取两边较大值（用 max 而非累加，保证反复同步不会把次数越滚越大）
    w.reviewCount = Math.max(w.reviewCount || 0, lose.reviewCount || 0);
    w.lastReview = Math.max(w.lastReview || 0, lose.lastReview || 0);

    // 熟记状态统一跟随「最后修改这条记录的一方」。
    // ⚠️ 不能用 masterTime 判断：取消熟记时 store 会把 masterTime 清零（见 setMaster），
    //    于是"刚刚才取消熟记"的一方反而像个从没标过熟的旧数据，会被对方更晚的
    //    masterTime 覆盖回去 —— 用户会发现"我明明点了不熟，怎么又变成熟了"。
    // 只在胜方压根没有这个字段时才从另一方补齐（老数据兼容）。
    if (w.isMaster === undefined && lose.isMaster !== undefined) {
      w.isMaster = lose.isMaster;
      w.masterTime = lose.masterTime;
    }
    return w;
  }

  function fillNote(win, lose) {
    const n = Object.assign({}, win);
    if (!n.title && lose.title) n.title = lose.title;
    if (!n.content && lose.content) n.content = lose.content;
    if (!n.createTime && lose.createTime) n.createTime = lose.createTime;
    return n;
  }

  /**
   * 合并远端文档与本地数据；返回合并后的文档
   * @param {Object} remote 远端文档（null 视为空）
   */
  function mergeDoc(remote) {
    const localDoc = docFromLocal();
    if (!remote) return localDoc;

    const tombs = {};
    const words = mergeList(localDoc.words, remote.words, localDoc.deleted, remote.deleted, tombs, fillWord);
    const notes = mergeList(localDoc.notes, remote.notes, localDoc.deleted, remote.deleted, tombs, fillNote);

    return {
      schema: 1,
      updatedAt: Date.now(),
      device: cfg.device || 'unknown',
      words: words,
      notes: notes,
      deleted: tombs
    };
  }

  /**
   * 防止「本地是空的 -> 把云端一起清光」
   * 正常运行下，合并结果变空只有一种合理原因：用户确实把这些词都删了（每条都有墓碑）。
   * 其余情况一律视为异常（读云端失败、数据损坏等），直接中止，宁可什么都不做。
   */
  function assertNotWipe(remote, merged) {
    const rw = (remote && remote.words) || [];
    if (!rw.length) return;                                   // 云端本来就没东西，不算清空
    if ((merged.words || []).length) return;                  // 没被清掉
    const allTombed = rw.every(w => !!(merged.deleted || {})[w.id]);
    if (!allTombed) {
      const e = new Error('已阻止一次危险的同步：本地没有这些单词，但云端有 ' + rw.length +
        ' 个，为避免覆盖丢失已中止。请确认本机数据是否正常，或先在云同步面板手动点一次「立即同步」。');
      e.code = 'WIPE_GUARD';
      throw e;
    }
  }

  /** 把合并结果写回本地 store（不触发被动推送） */
  function applyDoc(doc) {
    const db = SM.store.db;
    applying = true;
    try {
      db.words = doc.words || [];
      db.notes = doc.notes || [];
      db.deleted = doc.deleted || {};
      // updatedAt 缺失的补上，保证后续同步能正常比较
      const now = Date.now();
      db.words.forEach(w => { if (!w.updatedAt) w.updatedAt = w.createTime || now; });
      db.notes.forEach(n => { if (!n.updatedAt) n.updatedAt = n.updateTime || now; });
      SM.store.emit('sync:apply');
    } finally {
      applying = false;
    }
  }

  /* ---------------- 对外主流程 ---------------- */

  /** 是否已配置可用（有云空间 token / 或局域网模式） */
  function isEnabled() {
    if (cfg.mode === 'local') return true;
    return !!(cfg.token && cfg.gistId);
  }

  /**
   * 完整同步：拉远端 -> 与本地合并 -> 写回本地 + 推远端
   * @param {Object} opt {silent:Boolean 不弹提示}
   * @returns {Promise<Object>} {changed:Boolean, pushed:Boolean, words:Number}
   */
  function sync(opt) {
    opt = opt || {};
    if (busy) return Promise.resolve({ skipped: true, reason: 'busy' });
    if (!isEnabled()) return Promise.resolve({ skipped: true, reason: 'disabled' });

    busy = true;
    setState({ lastAttempt: Date.now(), error: '' });

    const t = transport();
    return t.load()
      .then(remote => {
        const merged = mergeDoc(remote);
        // ⚠️ 安全阀先于写入：云端有词、合并后却空了，且不是用户自己删光的 -> 拒绝执行
        assertNotWipe(remote, merged);

        const before = JSON.stringify(docFromLocal());
        applyDoc(merged);
        const after = JSON.stringify(docFromLocal());
        const localChanged = before !== after;

        // 本地或远端任一方有更新就推一次，保证两边尽快收敛
        return t.save(merged).then(() => {
          const words = (merged.words || []).length;
          const nowAt = Date.now();
          setState({ lastSync: nowAt, words: words, notes: (merged.notes || []).length, error: '' });
          if (!opt.silent) {
            u.toast(localChanged ? '已同步：' + words + ' 个单词' : '已是最新，无需同步');
          }
          return { changed: localChanged, pushed: true, words: words, transport: t.name };
        });
      })
      .catch(e => {
        const msg = (e && e.message) || String(e);
        setState({ error: msg });
        if (!opt.silent) u.toast('同步失败：' + msg, 3200);
        return { failed: true, error: msg, code: e && e.code };
      })
      .then(r => { busy = false; return r; });
  }

  /** 拉取并合并（不推送）—— 适合多设备都在写、想先看一眼的场景 */
  function pullOnly(opt) {
    if (busy) return Promise.resolve({ skipped: true });
    if (!isEnabled()) return Promise.resolve({ skipped: true });
    busy = true;
    return transport().load()
      .then(remote => {
        if (!remote) return { nothing: true };
        const merged = mergeDoc(remote);
        applyDoc(merged);
        if (!opt || !opt.silent) u.toast('已拉取云端数据');
        return { ok: true };
      })
      .catch(e => ({ failed: true, error: (e && e.message) || String(e) }))
      .then(r => { busy = false; return r; });
  }

  /* ---------------- 配置 / 凭据 ---------------- */

  /**
   * 配置 GitHub 同步
   * @param {String} token  GitHub Personal Access Token（只需 gist 权限）
   * @param {String} gistId 可选；留空则自动创建
   */
  function configure(token, gistId, mode) {
    cfg.token = String(token || '').trim();
    cfg.gistId = String(gistId || '').trim();
    cfg.mode = mode || 'gist';
    if (!cfg.device) cfg.device = u.uid ? u.uid('d') : ('d' + Date.now());
    saveCfg();
    return cfg;
  }

  function setMode(mode) {
    cfg.mode = mode === 'local' ? 'local' : 'gist';
    if (!cfg.device) cfg.device = u.uid ? u.uid('d') : ('d' + Date.now());
    saveCfg();
    return cfg.mode;
  }

  function getConfig() {
    return { token: cfg.token, gistId: cfg.gistId, mode: cfg.mode || 'gist', device: cfg.device, auto: cfg.auto !== false };
  }

  function status() {
    return {
      enabled: isEnabled(),
      mode: getConfig().mode,
      transportLabel: transport().label,
      gistId: cfg.gistId,
      hasToken: !!cfg.token,
      lastSync: st.lastSync || 0,
      lastAttempt: st.lastAttempt || 0,
      words: (st.words || 0),
      error: st.error || '',
      auto: cfg.auto !== false
    };
  }

  /** 断开：清掉凭据（本地数据保留） */
  function reset() {
    cfg = {}; st = {};
    try { localStorage.removeItem(KEY_CFG); localStorage.removeItem(KEY_STATE); } catch (e) { }
    stopAuto();
  }

  /* ---------------- 配对码：给第二台设备扫码/粘贴即可 ---------------- */
  function b64enc(s) {
    try { return btoa(unescape(encodeURIComponent(s))); }
    catch (e) { return null; }
  }
  function b64dec(s) {
    try { return decodeURIComponent(escape(atob(s))); }
    catch (e) { return null; }
  }

  /** 生成配对码（内含令牌与云空间 ID，务必只在自己的设备之间传递） */
  function makeCode() {
    if (!isEnabled()) return '';
    // SM1: 前缀版本标记，便于以后扩展
    return 'SM1:' + b64enc(JSON.stringify({ t: cfg.token, g: cfg.gistId, m: cfg.mode || 'gist' }));
  }

  /** 应用配对码 */
  function applyCode(code) {
    code = String(code || '').trim();
    const payload = code.indexOf('SM1:') === 0 ? code.slice(4) : code;
    const raw = b64dec(payload);
    if (!raw) throw new Error('配对码格式不正确');
    const obj = JSON.parse(raw);
    if (!obj.t) throw new Error('配对码里没有令牌');
    configure(obj.t, obj.g || '', obj.m || 'gist');
    return true;
  }

  /* ---------------- 自动同步 ---------------- */

  /** 本地数据变化 -> 延迟推送（连续标记熟记时不会一步步打接口） */
  function schedulePush() {
    if (!isEnabled() || applying || cfg.auto === false) return;
    clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      sync({ silent: true }).catch(() => { });
    }, 12000);
  }

  function startAuto() {
    if (timer) return;
    // 每次打开先从云端拉一次
    sync({ silent: true }).catch(() => { });
    timer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;  // 后台标签页不打扰
      sync({ silent: true }).catch(() => { });
    }, 5 * 60 * 1000);

    SM.store.subscribe(function (reason) {
      if (reason === 'sync:apply') return;   // 同步写回引发的变更不再回推
      schedulePush();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && isEnabled() && cfg.auto !== false) {
        sync({ silent: true }).catch(() => { });
      }
    });
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
    if (pending) { clearTimeout(pending); pending = null; }
  }

  function setAuto(on) {
    cfg.auto = !!on;
    saveCfg();
    if (cfg.auto) { stopAuto(); startAuto(); }
    return cfg.auto;
  }

  /* ---------------- 导出 ---------------- */
  SM.sync = {
    sync, pullOnly, configure, setMode, getConfig, status, reset, setAuto,
    startAuto, stopAuto, isEnabled,
    makeCode, applyCode,
    onStateChange,
    // 暴露给自动化测试做纯逻辑校验
    _internal: { mergeList, mergeDoc, docFromLocal, applyDoc, fillWord, parseDoc, assertNotWipe, file: FILE }
  };
})(window.SM);
