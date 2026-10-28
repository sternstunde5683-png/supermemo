/* ==========================================================================
 * importer.js —— 文档 / 笔记文本导入 与 英文单词提取
 *   · 支持 .txt / .md / .csv / .json  直接读取
 *   · 支持 .docx  通过按需加载 mammoth（CDN）解析，失败时提示用户转存 txt
 *   · extractWords(text)：从任意英文文本中提取生词候选（去停用词、去重、计频）
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils;

  /* ---------------- 单词提取 ---------------- */
  /**
   * 从文本中提取英文单词候选
   * @param {String} text
   * @param {Object} opt {minLen:Number, keepStop:Boolean}
   * @returns {Array<{word:String,count:Number}>} 按出现次数倒序
   */
  function extractWords(text, opt) {
    opt = opt || {};
    const minLen = opt.minLen || 3;
    const map = {};
    const re = /[A-Za-z][A-Za-z'’\-]*/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      let w = m[0].replace(/[’']s$/i, '').replace(/^-+|-+$/g, '');
      if (w.length < minLen) continue;
      const low = w.toLowerCase();
      if (!opt.keepStop && u.isStopWord(low)) continue;
      map[low] = (map[low] || 0) + 1;
    }
    return Object.keys(map)
      .map(w => ({ word: w, count: map[w] }))
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  }

  /* ---------------- docx 解析（按需加载 mammoth） ---------------- */
  let mammothLoading = null;
  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothLoading) {
      mammothLoading = u.loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
        () => !!window.mammoth);
    }
    return mammothLoading.then(() => window.mammoth);
  }

  function readDocx(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取 docx 失败'));
      fr.readAsArrayBuffer(file);
    })
      .then(buf => loadMammoth().then(mm => mm.extractRawText({ arrayBuffer: buf })))
      .then(res => res && res.value ? res.value : '')
      .catch(e => {
        u.toast('docx 解析失败，建议另存为 .txt 后导入');
        throw e;
      });
  }

  /**
   * 读取单个文件 -> {title, content}
   * @param {File} file
   */
  function readFile(file) {
    const name = file.name || '未命名';
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'docx') {
      return readDocx(file).then(text => ({ title: name.replace(/\.docx$/i, ''), content: text }));
    }
    return u.readTextFile(file).then(text => {
      if (ext === 'json') {
        // 兼容「超级记忆」备份文件：提取单词原文
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data.words)) {
            const w = data.words.map(x => x.word).join(' ');
            return { title: name.replace(/\.json$/i, ''), content: w + '\n' + (data.notes || []).map(n => n.content).join('\n') };
          }
        } catch (e) { /* 非备份 json，按纯文本处理 */ }
      }
      return { title: name.replace(/\.[a-z]+$/i, ''), content: text };
    });
  }

  /** 批量读取文件 */
  function readFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(readFile)).catch(e => { console.warn(e); return []; });
  }

  SM.importer = { extractWords, readFile, readFiles, loadMammoth };
})(window.SM);
