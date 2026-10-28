/* ==========================================================================
 * utils.js —— 通用工具 / DOM 助手 / 弹层 / 提示
 * 全局命名空间：window.SM
 * ========================================================================== */
window.SM = window.SM || {};

(function (SM) {
  'use strict';

  /* ---------------- DOM 助手 ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /** 快速创建元素：el('div.cls', {html/text/...attrs}) */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.keys(v).forEach(d => node.dataset[d] = v[d]);
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  /* ---------------- 提示 Toast ---------------- */
  let toastTimer = null;
  function toast(msg, ms) {
    const box = $('#toast');
    if (!box) return;
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms || 2000);
  }

  /* ---------------- 弹层 Modal ---------------- */
  const Modal = {
    /** open({title, body(Node|string), actions:[{text,type,onClick}]}) */
    open(opt) {
      const root = $('#modalRoot'), box = $('#modalBox');
      box.innerHTML = '';

      const head = el('div', { class: 'modal-title' }, [
        el('span', { text: opt.title || '' }),
        el('button', { class: 'modal-close', html: '&times;', onClick: () => Modal.close() })
      ]);
      box.appendChild(head);

      const content = el('div', { class: 'modal-content' });
      if (typeof opt.body === 'string') content.innerHTML = opt.body;
      else if (opt.body) content.appendChild(opt.body);
      box.appendChild(content);

      if (opt.actions && opt.actions.length) {
        const bar = el('div', { class: 'modal-actions' });
        opt.actions.forEach(a => {
          bar.appendChild(el('button', {
            class: 'act-btn ' + (a.type || 'ghost'),
            text: a.text,
            onClick: () => { if (a.onClick) a.onClick(content); if (a.close !== false) Modal.close(); }
          }));
        });
        box.appendChild(bar);
      }

      root.hidden = false;
      box.dataset.title = opt.title || '';
      // 自动聚焦第一个输入框
      const firstInput = box.querySelector('input,textarea');
      if (firstInput) setTimeout(() => firstInput.focus(), 60);
      return content;
    },
    close() { $('#modalRoot').hidden = true; },
    /** 确认框：confirm(msg).then(ok=>{}) */
    confirm(title, msg, okText) {
      return new Promise(resolve => {
        Modal.open({
          title: title,
          body: '<p style="margin:0;font-size:14px;color:#6b726d">' + escapeHtml(msg) + '</p>',
          actions: [
            { text: '取消', onClick: () => resolve(false), close: true },
            { text: okText || '确定', type: 'danger', onClick: () => resolve(true), close: true }
          ]
        });
      });
    }
  };

  /* ---------------- 字符串 / 格式化 ---------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** 生成唯一 id */
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 防抖 */
  function debounce(fn, wait) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), wait || 250);
    };
  }

  /** 相对/绝对时间显示 */
  function timeAgo(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /** 判断是否为今天 */
  function isToday(ts) {
    if (!ts) return false;
    return new Date(ts).toDateString() === new Date().toDateString();
  }

  /* ---------------- 词性处理 ---------------- */
  // 词典 API 返回的词性 -> 缩写标准形式
  const POS_MAP = {
    'noun': 'n.', 'verb': 'v.', 'adjective': 'adj.', 'adverb': 'adv.',
    'preposition': 'prep.', 'conjunction': 'conj.', 'pronoun': 'pron.',
    'interjection': 'int.', 'numeral': 'num.', 'article': 'art.',
    'determiner': 'det.', 'exclamation': 'int.', 'abbreviation': 'abbr.',
    'phrase': 'phrase', 'idiom': 'idiom', 'particle': 'part.'
  };
  const POS_CN = {
    'n.': '名词', 'v.': '动词', 'adj.': '形容词', 'adv.': '副词',
    'prep.': '介词', 'conj.': '连词', 'pron.': '代词', 'int.': '感叹词',
    'num.': '数词', 'art.': '冠词', 'det.': '限定词', 'abbr.': '缩写',
    'phrase': '短语', 'idiom': '习语', 'part.': '助词', 'other': '其他'
  };

  /** 标准化词性字符串 */
  function normPos(pos) {
    if (!pos) return 'other';
    const p = String(pos).toLowerCase().trim();
    if (POS_MAP[p]) return POS_MAP[p];
    // 已经是缩写形式
    const short = p.replace(/\.$/, '') + '.';
    if (POS_CN[short]) return short;
    return p;
  }
  /** 词性 -> 中文名 */
  function posCn(pos) { return POS_CN[pos] || pos || '其他'; }
  /** 词性 -> badge 样式类 */
  function posClass(pos) {
    if (pos === 'v.') return 'v';
    if (pos === 'n.') return 'n';
    if (pos === 'adj.') return 'adj';
    if (pos === 'adv.') return 'adv';
    return '';
  }

  /* ---------------- 高频停用词（导入时过滤） ---------------- */
  const STOP_WORDS = ('a an the and or but if then than that this these those there here of in on at to for with ' +
    'from by as is am are was were be been being do does did done have has had having i you he she it we they me ' +
    'him her them my your his its our their mine yours hers ours theirs who whom whose which what when where why how ' +
    'not no nor so very can could will would shall should may might must about into over under again further once ' +
    'all any both each few more most other some such only own same too s t just don now up out off above below between ' +
    'because while during before after also get got make made take took go went come came see saw know knew think ' +
    'think want need use used one two three four five six seven eight nine ten').split(/\s+/);

  const stopSet = {};
  STOP_WORDS.forEach(w => stopSet[w] = 1);
  function isStopWord(w) { return !!stopSet[String(w).toLowerCase()]; }

  /* ---------------- 文件下载 / 读取 ---------------- */
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 读取文本文件（.txt/.md/.csv） */
  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsText(file, 'utf-8');
    });
  }

  /** 动态加载外部脚本（用于 OCR 引擎等按需加载） */
  function loadScript(src, check) {
    return new Promise((resolve, reject) => {
      if (check && check()) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('脚本加载失败：' + src));
      document.head.appendChild(s);
    });
  }

  /** 网络请求（带超时） */
  function fetchJson(url, timeout) {
    return new Promise((resolve, reject) => {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctl) ctl.abort(); reject(new Error('请求超时')); }, timeout || 12000);
      fetch(url, ctl ? { signal: ctl.signal } : undefined)
        .then(r => {
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(resolve)
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  /** 并发受限的批量任务（带进度回调） */
  function batch(list, limit, worker, onProgress) {
    return new Promise((resolve) => {
      const results = new Array(list.length);
      let index = 0, completed = 0;
      if (!list.length) { onProgress && onProgress(0, 0); return resolve(results); }
      function runOne() {
        if (index >= list.length) return;
        const i = index++;
        Promise.resolve(worker(list[i], i))
          .then(r => results[i] = r)
          .catch(() => results[i] = null)
          .then(() => {
            completed++;
            onProgress && onProgress(completed, list.length);
            if (completed >= list.length) resolve(results);
            else runOne();
          });
      }
      for (let k = 0; k < Math.min(limit, list.length); k++) runOne();
    });
  }

  SM.utils = {
    $, $$, el, toast, Modal, escapeHtml, uid, debounce,
    timeAgo, isToday, normPos, posCn, posClass, POS_CN,
    isStopWord, STOP_WORDS, download, readTextFile, loadScript, fetchJson, batch
  };
})(window.SM);
