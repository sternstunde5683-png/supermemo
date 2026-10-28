/* ==========================================================================
 * ocr.js —— 图片 OCR 识别 + 放大 / 自定义圈选 / 选区可编辑
 *   · 识别引擎：Tesseract.js（本地自托管，失败自动回退 CDN）
 *   · 识别前先做图像增强（缩放 + 灰度 + 锐化 + 对比度拉伸），显著提升准确率
 *   · 多套分页模式依次尝试，自动挑「完整单词最多、碎片最少」的那次结果
 *   · ★ 中文过滤：噪音词 / 方块字密度双重判定，避免把中文认成怪单词
 *   · ★ 自定义圈选：手指在图上拖出方框 -> 只识别框内区域（作业帮式）
 *   · ★ 选区可编辑：拖框体移动、拖四角改大小、随时删除，改完自动重新识别
 *   · 接口预留：replaceEngine(fn) 可替换为后端 OCR 服务
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils;

  /* ---------------- 内部状态 ---------------- */
  const state = {
    file: null,
    imgUrl: '',
    img: null,            // 原图 Image（圈选裁剪用）
    natural: { w: 0, h: 0 },
    words: [],            // [{text, bbox, conf, selected, custom, rid}]
    regions: [],          // 自定义圈选区 [{id,x0,y0,x1,y1(百分比),words:[],busy}]
    nextId: 1,
    activeId: 0,
    engine: null,
    running: false,
    mode: 'select',       // select=圈选取词 | pan=移动/缩放
    view: { scale: 1, tx: 0, ty: 0 },
    vp: null, scene: null, marquee: null, regionLayer: null,
    onChange: null,
    onZoom: null,
    gray: null,           // 灰度缩略图（中文密度判定用）
    worker: null          // 复用的识别 worker（圈选二次识别用）
  };

  /* ---------------- 加载识别引擎 ---------------- */
  function assetBase() {
    return location.pathname.replace(/[^/]*$/, '');
  }
  const VENDOR = assetBase() + 'assets/vendor/tesseract/';
  const LOCAL_ENGINE = VENDOR + 'tesseract.min.js';
  const ENGINE_CDNS = [
    LOCAL_ENGINE,
    'https://registry.npmmirror.com/tesseract.js/4.1.1/files/dist/tesseract.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@4.1.1/dist/tesseract.min.js'
  ];
  let loadingPromise = null;

  function loadEngine() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (loadingPromise) return loadingPromise;
    loadingPromise = new Promise((resolve, reject) => {
      let i = 0;
      function tryNext() {
        if (window.Tesseract) return resolve(window.Tesseract);
        if (i >= ENGINE_CDNS.length) {
          loadingPromise = null;
          return reject(new Error('识别引擎加载失败（网络不可达），请改用文本导入或手动录入'));
        }
        const url = ENGINE_CDNS[i++];
        u.loadScript(url, () => !!window.Tesseract)
          .then(() => window.Tesseract ? resolve(window.Tesseract) : tryNext())
          .catch(tryNext);
      }
      tryNext();
    });
    return loadingPromise;
  }

  /** 预留：替换识别引擎（如接入自建后端 OCR 服务） */
  function replaceEngine(fn) { state.engine = fn; }

  /* ---------------- 图片 -> 单词框 ---------------- */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = url;
    });
  }

  /**
   * 图像增强：灰度 + 轻度锐化 + 直方图拉伸。
   * 手机拍照常有阴影、反光、摩尔纹，直接喂给 Tesseract 会把一个单词切成一堆字母；
   * 先做这步能把「全是字母」的情况大幅减少。
   */
  function enhance(cv, ctx) {
    const w = cv.width, h = cv.height;
    if (!w || !h) return;
    let id;
    try { id = ctx.getImageData(0, 0, w, h); } catch (e) { return; }  // 极少数浏览器限制取像素
    const d = id.data, n = w * h;

    // 1) 转灰度 + 直方图
    const g = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      g[p] = v;
      hist[v < 0 ? 0 : v > 255 ? 255 : v | 0]++;
    }

    // 2) 轻度锐化（unsharp mask，3x3 均值做底）
    const AMOUNT = 0.6;
    const s = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const r2 = yy * w;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += g[r2 + xx]; cnt++;
          }
        }
        s[row + x] = g[row + x] + (g[row + x] - sum / cnt) * AMOUNT;
      }
    }

    // 3) 2% / 98% 分位拉伸，拉开字与底的对比
    const total = n;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.98) { hi = v; break; } }
    if (hi - lo < 40) { lo = 0; hi = 255; }
    const k = 255 / Math.max(1, hi - lo);

    for (let p = 0, i = 0; p < n; p++, i += 4) {
      let v = (s[p] - lo) * k;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const b = v | 0;
      d[i] = b; d[i + 1] = b; d[i + 2] = b; d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  /** 缩略灰度图：用于判断某块区域是不是中文（汉字笔画密度明显高于英文） */
  function buildGray(cv) {
    state.gray = null;
    try {
      const w = cv.width, h = cv.height;
      const s = Math.min(1, 900 / Math.max(1, w));
      const gw = Math.max(1, Math.round(w * s)), gh = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas');
      c.width = gw; c.height = gh;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(cv, 0, 0, gw, gh);
      const id = cx.getImageData(0, 0, gw, gh).data;
      const g = new Uint8Array(gw * gh);
      for (let i = 0, p = 0; p < gw * gh; i += 4, p++) {
        g[p] = (id[i] * 0.299 + id[i + 1] * 0.587 + id[i + 2] * 0.114) | 0;
      }
      state.gray = { w: gw, h: gh, data: g };
    } catch (e) { state.gray = null; }
  }

  /** 一块区域里「墨迹」像素占比（越大越像汉字/图片块） */
  function inkRatio(bbox) {
    const g = state.gray;
    if (!g || !bbox) return 0;
    const nw = state.natural.w || 1, nh = state.natural.h || 1;
    const x0 = Math.max(0, Math.floor((bbox.x0 || 0) / nw * g.w));
    const x1 = Math.min(g.w, Math.ceil((bbox.x1 || 0) / nw * g.w));
    const y0 = Math.max(0, Math.floor((bbox.y0 || 0) / nh * g.h));
    const y1 = Math.min(g.h, Math.ceil((bbox.y1 || 0) / nh * g.h));
    if (x1 <= x0 || y1 <= y0) return 0;
    let dark = 0, tot = 0;
    for (let y = y0; y < y1; y++) {
      const r = y * g.w;
      for (let x = x0; x < x1; x++) { if (g.data[r + x] < 128) dark++; tot++; }
    }
    return tot ? dark / tot : 0;
  }

  /**
   * 预处理：统一缩放到识别效果较好的尺寸 + 图像增强
   * @returns {Promise<{blob:Blob, w:number, h:number, cv:HTMLCanvasElement}>}
   */
  function preprocess(file) {
    const MIN_W = 1500, MAX_W = 3200;
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        let scale = 1;
        if (w < MIN_W) scale = MIN_W / w;
        else if (w > MAX_W) scale = MAX_W / w;
        const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
        try {
          const cv = document.createElement('canvas');
          cv.width = tw; cv.height = th;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff';                 // 白底，避免透明 PNG 干扰
          ctx.fillRect(0, 0, tw, th);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, tw, th);
          enhance(cv, ctx);
          buildGray(cv);
          cv.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) resolve({ blob: blob, w: tw, h: th, cv: cv });
            else reject(new Error('图片处理失败'));
          }, 'image/png');
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /**
   * 识别图片
   * @param {File} file
   * @param {Function} onStatus (text, progress)
   * @returns {Promise<Array>} words（含 bbox）
   */
  function recognize(file, onStatus) {
    dropWorker();
    state.file = file;
    if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
    state.imgUrl = URL.createObjectURL(file);
    state.running = true;
    state.words = [];
    state.regions = [];
    state.activeId = 0;
    state.natural = { w: 0, h: 0 };
    resetView();

    const status = onStatus || function () { };
    // 原图留着，圈选时按百分比从原图裁剪
    loadImage(state.imgUrl).then(img => { state.img = img; }).catch(() => { });

    if (state.engine) {
      return loadImage(state.imgUrl)
        .then(img => { state.natural = { w: img.naturalWidth, h: img.naturalHeight }; return state.engine(file, state.natural); })
        .then(words => { state.words = (words || []).map(normWord); state.running = false; return state.words; });
    }

    return preprocess(file)
      .then(proc => {
        state.natural = { w: proc.w, h: proc.h };   // 坐标基于处理后的图
        status('正在加载识别引擎…', 0.05);
        return loadEngine().then(T => ({ T: T, blob: proc.blob, cv: proc.cv }));
      })
      .then(ctx => runPasses(ctx.T, ctx.blob, status))
      .then(list => {
        state.words = list;
        state.running = false;
        const q = qualityOf(state.words);
        status('识别完成，共 ' + q.valid + ' 个单词。<b>点单词</b>勾选/取消，或在单词上<b>拖框圈选</b>重新识别', 1);
        return state.words;
      })
      .catch(e => {
        state.running = false;
        console.warn('[ocr] 识别失败', e);
        status('识别失败：' + (e && e.message ? e.message : '未知错误') + '，可改用文本导入', 0);
        throw e;
      });
  }

  /* ---------------- 识别执行 ----------------
   * 引擎首选本地 vendor（离线可用、速度最快），但它有近 16MB，
   * 部署到 GitHub Pages 时上传会被网络打断，所以云端仓库不带这些文件，
   * 这时自动改从公共 CDN 拉取。两套都失败才会报错。
   */
  const MIRROR = 'https://registry.npmmirror.com';
  const JSD = 'https://cdn.jsdelivr.net/npm';
  const LANG_DATA = JSD + '/@tesseract.js-data/eng/4.0.0_best_int/';

  const LOCAL_CFG = {
    workerPath: VENDOR + 'worker.min.js',
    corePath: VENDOR + 'tesseract-core-simd.wasm.js',
    langPath: VENDOR
  };
  const CDN_CFGS = [
    { workerPath: JSD + '/tesseract.js@4.1.1/dist/worker.min.js', corePath: JSD + '/tesseract.js-core@4.0.2/tesseract-core-simd.wasm.js', langPath: LANG_DATA },
    { workerPath: MIRROR + '/tesseract.js/4.1.1/files/dist/worker.min.js', corePath: MIRROR + '/tesseract.js-core/4.0.2/files/tesseract-core-simd.wasm.js', langPath: LANG_DATA },
    { workerPath: 'https://unpkg.com/tesseract.js@4.1.1/dist/worker.min.js', corePath: 'https://unpkg.com/tesseract.js-core@4.0.2/tesseract-core-simd.wasm.js', langPath: LANG_DATA },
    {}   // 最后一招：让库用自己内置的默认地址
  ];

  let vendorState = null;   // null=未探测；true=本地引擎在；false=没有

  /** 本地 vendor 是否真的存在（云端部署时这里会是 404） */
  function probeVendor() {
    if (vendorState !== null) return Promise.resolve(vendorState);
    if (typeof fetch !== 'function' || location.protocol === 'file:') {
      vendorState = false;
      return Promise.resolve(false);
    }
    return fetch(VENDOR + 'worker.min.js', { method: 'HEAD' })
      .then(r => { vendorState = r.ok; return vendorState; })
      .catch(() => { vendorState = false; return false; });
  }

  function buildCfgs() {
    return probeVendor().then(ok => ok ? [LOCAL_CFG].concat(CDN_CFGS) : CDN_CFGS.slice());
  }

  // 只认英文字母（含撇号、连字符），能明显减少把字母认成数字/符号的错乱
  const WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'-";

  // 分页模式：自动 -> 整块文字 -> 稀疏文字，按效果择优
  const PASSES = [
    { name: '自动分页', psm: '3' },
    { name: '整块文字', psm: '6' },
    { name: '稀疏文字', psm: '11' }
  ];

  function friendlyStatus(s) {
    const map = {
      'loading tesseract core': '正在加载识别核心…',
      'initializing tesseract': '正在初始化识别引擎…',
      'loading language traineddata': '正在加载英文语言包…',
      'loaded language traineddata': '语言包就绪…',
      'initializing api': '正在准备识别…',
      'recognizing text': '正在识别图片中的文字…'
    };
    return map[s] || (s ? '引擎状态：' + s : '');
  }

  function makeLogger(status, base) {
    return function (m) {
      if (!m) return;
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        status('正在识别图片中的文字…', base + m.progress * 0.25);
      } else if (m.status) {
        status(friendlyStatus(m.status), base);
      }
    };
  }

  /** 创建 worker（v4 / v5 两种签名都兼容） */
  function createWorkerSmart(T, cfgs, cfgIndex, status) {
    const cfg = cfgs[cfgIndex] || {};
    const opts = Object.assign({ logger: makeLogger(status, 0.06) }, cfg);
    function v4() { return Promise.resolve(T.createWorker(opts)); }
    function v5() { return Promise.resolve(T.createWorker('eng', 1, opts)); }
    return v4().catch(v5).then(w => {
      if (!w) throw new Error('worker 创建失败');
      if (typeof w.loadLanguage === 'function') {
        return Promise.resolve(w.loadLanguage('eng'))
          .then(() => Promise.resolve(w.initialize('eng')))
          .then(() => w)
          .catch(() => w);
      }
      return w;
    }).catch(e => {
      if (cfgIndex + 1 < cfgs.length) return createWorkerSmart(T, cfgs, cfgIndex + 1, status);
      throw e;
    });
  }

  /**
   * 多种分页模式依次识别，把结果「合并去重」而不是只挑一次：
   * 每种模式各有漏词（短文尤甚），并集通常比任何单次结果都全。
   * 相同文本 + 位置基本重叠的视为同一个词（保留置信度高的那次）。
   */
  function bboxOverlapRatio(a, b) {
    if (!a || !b) return 0;
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = ix * iy;
    const a1 = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
    const a2 = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    return inter / Math.min(a1, a2);
  }
  function centerDist(a, b) {
    const ax = ((a.x0 || 0) + (a.x1 || 0)) / 2, ay = ((a.y0 || 0) + (a.y1 || 0)) / 2;
    const bx = ((b.x0 || 0) + (b.x1 || 0)) / 2, by = ((b.y0 || 0) + (b.y1 || 0)) / 2;
    return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
  }
  function mergePasses(lists) {
    const out = [];
    lists.forEach(list => list.forEach(w => {
      const h = Math.max(1, heightOf(w.bbox));
      const dup = out.find(x => x.text === w.text && (
        bboxOverlapRatio(x.bbox, w.bbox) > 0.4 || centerDist(x.bbox, w.bbox) < h * 0.8));
      if (!dup) out.push(w);
      else if ((w.conf || 0) > (dup.conf || 0)) dup.conf = w.conf;
    }));
    return out;
  }

  /** 依次尝试多种分页模式，合并所有结果（补漏） */
  function runPasses(T, blob, status) {
    return buildCfgs().then(cfgs => createWorkerSmart(T, cfgs, 0, status)).then(function (worker) {
      const tries = [];
      let i = 0;

      function recognizePass(p) {
        status(i ? '换「' + p.name + '」模式再扫一遍，把漏掉的单词补齐…' : '正在识别图片中的文字…',
          0.1 + i * 0.18);
        return setParams(worker, p.psm)
          .then(function () {
            // 单次识别超时保护（语言包较大，给足 120 秒）
            const timeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('识别超时（语言包下载过慢）')), 120000));
            return Promise.race([Promise.resolve(worker.recognize(blob)), timeout]);
          })
          .then(function (r) {
            const raw = (r && r.data && r.data.words) || [];
            const list = postProcess(raw);
            tries.push(list);
            i++;
            return list;
          })
          .catch(function () { i++; return []; });
      }

      function finish() {
        const merged = mergePasses(tries);
        const best = pickBest(tries);
        return qualityOf(merged).score >= qualityOf(best).score ? merged : best;
      }

      function next() {
        if (i >= PASSES.length) return Promise.resolve(finish());
        return recognizePass(PASSES[i]).then(function (list) {
          const q = qualityOf(list);
          // 第一遍（自动分页）效果就好：再补一遍「整块文字」合并收工，省时间
          if (i === 1 && q.good && q.valid >= 10) return recognizePass(PASSES[1]).then(finish);
          if (i >= PASSES.length) return finish();
          return next();
        });
      }

      return next().then(function (result) {
        // 保留 worker 复用：用户圈选时要对局部再做一次识别，重建 worker 太慢
        state.worker = worker;
        return result;
      }, function (e) {
        try { worker.terminate(); } catch (e2) { }
        throw e;
      });
    }).catch(function (e) {
      // worker 方案整体失败 -> 退回最简单的一次性识别
      console.warn('[ocr] worker 识别失败，回退简单识别', e);
      return recognizeSimple(T, blob, status).then(r => postProcess((r && r.data && r.data.words) || []));
    });
  }

  function setParams(worker, psm, whitelist) {
    if (typeof worker.setParameters !== 'function') return Promise.resolve();
    const p = { tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' };
    if (whitelist) p.tessedit_char_whitelist = whitelist;
    return Promise.resolve(worker.setParameters(p)).catch(function () { });
  }

  function recognizeSimple(T, file, status) {
    return buildCfgs().then(function (cfgs) {
      let i = 0;
      function attempt() {
        const cfg = cfgs[i] || {};
        const opts = Object.assign({ logger: makeLogger(status, 0.1) }, cfg);
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('识别超时')), 120000));
        return Promise.race([Promise.resolve(T.recognize(file, 'eng', opts)), timeout])
          .catch(e => {
            i++;
            if (i < cfgs.length) return attempt();
            throw e;
          });
      }
      return attempt();
    });
  }

  /** 一次识别结果的质量评估 */
  function qualityOf(list) {
    let valid = 0, single = 0, conf = 0;
    list.forEach(w => {
      if (w.text.length === 1) single++;
      else if (w.text.length >= 2) valid++;
      conf += w.conf || 0;
    });
    const avg = list.length ? conf / list.length : 0;
    return {
      valid: valid, single: single, avg: avg,
      score: valid - single * 1.4,
      good: valid >= 8 && single <= Math.max(2, valid * 0.25) && avg >= 45
    };
  }

  function pickBest(lists) {
    let best = [], bestScore = -1e9;
    lists.forEach(l => {
      const q = qualityOf(l);
      const s = q.score + q.avg * 0.02;
      if (s > bestScore) { bestScore = s; best = l; }
    });
    return best;
  }

  /* ======================================================================
   * 中文 / 噪音过滤
   * ==================================================================== */
  const VOWEL_RE = /[aeiouy]/i;
  const ONE_LETTER_OK = { a: 1, i: 1 };
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

  /** 本地词典（用于判断识别结果像不像真单词） */
  function inDict(t) {
    const D = window.SM_LOCAL_DICT;
    if (!D) return true;                 // 没词库就不做这层判定
    if (D[t]) return true;
    const alts = [];
    if (/ies$/.test(t)) alts.push(t.replace(/ies$/, 'y'));
    if (/(ches|shes|sses|xes|zes)$/.test(t)) alts.push(t.replace(/es$/, ''));
    if (/s$/.test(t)) alts.push(t.slice(0, -1));
    if (/ing$/.test(t)) { alts.push(t.slice(0, -3)); alts.push(t.slice(0, -3) + 'e'); }
    if (/ed$/.test(t)) { alts.push(t.slice(0, -2)); alts.push(t.slice(0, -1)); }
    if (/ly$/.test(t)) alts.push(t.slice(0, -2));
    if (/er$/.test(t)) { alts.push(t.slice(0, -2)); alts.push(t.slice(0, -1)); }
    if (/est$/.test(t)) { alts.push(t.slice(0, -3)); alts.push(t.slice(0, -2)); }
    for (let i = 0; i < alts.length; i++) if (D[alts[i]]) return true;
    return false;
  }

  /**
   * 这段文字像不像一个英文单词？
   * 中文旁边常会被认成 "zlt" "ooo" "mn" 这类怪串，这里一并挡掉。
   */
  function isNoise(t, conf) {
    if (!t) return true;
    if (CJK_RE.test(t)) return true;                       // 含中日韩字符
    if (t.length === 1) return !ONE_LETTER_OK[t] || (conf || 0) < 70;
    if (/(.)\1{2,}/.test(t)) return true;                  // aaa / ooo
    if (!VOWEL_RE.test(t) && t.length >= 3) return true;   // 没有元音：wrd / xktp
    if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(t)) return true; // 连续 5 个以上辅音
    const v = (t.match(/[aeiouy]/gi) || []).length;
    if (t.length >= 5 && v / t.length < 0.15) return true; // 元音比例过低
    // 低置信度又不像词 -> 才是噪音。
    // ★ 阈值从 62 放宽到 45：以前大量真实生词（恰恰是要背的）被这条误杀了
    if (t.length >= 5 && (conf || 0) < 45 && !inDict(t)) return true;
    return false;
  }

  /** 方块字判定：汉字「字宽≈字高 + 笔画密度高」，英文则是窄而疏 */
  function looksLikeCJK(w) {
    const b = w.bbox || {};
    const bw = Math.max(1, (b.x1 || 0) - (b.x0 || 0));
    const bh = Math.max(1, (b.y1 || 0) - (b.y0 || 0));
    const charW = bw / Math.max(1, w.text.length);
    const aspect = charW / bh;                 // 英文约 0.4~0.75，汉字约 0.85~1.15
    const ink = inkRatio(b);                   // 汉字墨迹明显更密
    let s = 0;
    if (aspect > 0.85) s++;
    if (ink > 0.42) s++;
    if (w.text.length <= 2 && aspect > 0.8) s++;
    return s >= 2;
  }

  /** 规范化一个识别结果词：清洗 + 坐标记录
   *  ★ 一律不自动选中 —— 由用户在图片上圈选 / 点选决定要背哪些词 */
  function normWord(w) {
    let text = String(w.text || '')
      .replace(/[^A-Za-z'\-]/g, '')
      .replace(/^['\-]+|['\-]+$/g, '')
      .trim().toLowerCase();
    return {
      text: text,
      bbox: w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
      conf: w.confidence || 0,
      selected: false
    };
  }

  /**
   * 后处理：过滤噪音碎片 + 剔除中文区 + 把被切开的单词重新拼回去
   * Tesseract 常把 beautiful 切成 "beauti"+"ful"，甚至切成一串单字母，
   * 这里按「同一行 + 间距很小」把它们合并，保证框出来的是完整单词。
   */
  /**
   * 把被识别成一整块的多个单词再切开。
   * 排版密的短文里 Tesseract 常把 "the beautiful morning" 当成一个词吐出来，
   * 结果整行只有一个超大框，里面的单词一个都选不了 —— 这里按词典把它劈成正常的词，
   * 坐标按字符数比例分配。已经是个完整单词的（heart/he/art）不会被误切。
   */
  // 离线词库里没有的高频小词（the / of / and …）—— 短文里最容易跟别的词粘在一起的就是它们
  const COMMON_WORDS = {};
  ('a an the of to in on at is it as be he we you i for and but or so if do go no up out all my me ' +
    'his her him our your was are were has had that this with from not can will she they there here ' +
    'what when who how why which one two more most very just like into over after then than them some')
    .split(' ').forEach(s => { COMMON_WORDS[s] = 1; });

  /** 这段能不能独立成词（离线词库 + 常见小词表） */
  function partWord(s) { return inDict(s) || !!COMMON_WORDS[s]; }

  function splitStuckWords(list) {
    let cur = list, round = 0;
    while (round++ < 3) {
      const out = [];
      let changed = false;
      cur.forEach(w => {
        const t = w.text || '';
        const b = w.bbox || {};
        if (t.length < 5 || t.length > 26 || inDict(t)) { out.push(w); return; }
        let best = -1, bestScore = 0;
        for (let i = 2; i <= t.length - 2; i++) {
          const L = t.slice(0, i), R = t.slice(i);
          if (!partWord(L) || !partWord(R)) continue;
          const score = Math.min(L.length, R.length);
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) { out.push(w); return; }
        changed = true;
        const x0 = b.x0 || 0, x1 = b.x1 || 0;
        const mid = x0 + (x1 - x0) * (best / t.length);
        out.push({
          text: t.slice(0, best), conf: w.conf, selected: false,
          bbox: { x0: x0, y0: b.y0 || 0, x1: mid, y1: b.y1 || 0 }
        });
        out.push({
          text: t.slice(best), conf: w.conf, selected: false,
          bbox: { x0: mid, y0: b.y0 || 0, x1: x1, y1: b.y1 || 0 }
        });
      });
      cur = out;
      if (!changed) break;
    }
    return cur;
  }

  function postProcess(raw) {
    let list = raw.map(normWord).filter(w => !!w.text);
    // 低置信度的孤立单字母基本都是噪声
    list = list.filter(w => !(w.text.length < 2 && (w.conf || 0) < 55));
    list = mergeFragments(list);
    list = splitStuckWords(list);        // ★ 粘成一坨的多个单词 -> 拆回一个个词
    // 仍是噪音的丢掉
    list = list.filter(w => !isNoise(w.text, w.conf));
    // 中文区域：形状像方块字、墨迹又密的，直接丢掉
    list = list.filter(w => !looksLikeCJK(w));
    return list;
  }

  function centerY(b) { return ((b.y0 || 0) + (b.y1 || 0)) / 2; }
  function heightOf(b) { return Math.max(1, (b.y1 || 0) - (b.y0 || 0)); }

  function mergeFragments(list) {
    if (!list.length) return list;
    const items = list.slice().sort((a, b) => centerY(a.bbox) - centerY(b.bbox));
    const lines = [];
    let cur = [items[0]];
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1], b = items[i];
      const sameLine = Math.abs(centerY(a.bbox) - centerY(b.bbox)) <
        Math.max(heightOf(a.bbox), heightOf(b.bbox)) * 0.6;
      if (sameLine) cur.push(b);
      else { lines.push(cur); cur = [b]; }
    }
    lines.push(cur);

    const out = [];
    lines.forEach(line => {
      line.sort((a, b) => (a.bbox.x0 || 0) - (b.bbox.x0 || 0));
      let acc = line[0];
      for (let i = 1; i < line.length; i++) {
        const nx = line[i];
        const gap = (nx.bbox.x0 || 0) - (acc.bbox.x1 || 0);
        const len = Math.max(1, acc.text.length);
        const charW = ((acc.bbox.x1 || 0) - (acc.bbox.x0 || 0)) / len;
        // 单字母碎片之间允许更大的间隙（应对 "b e a u t i f u l" 这种切碎）
        // 两个本来就是完整单词 -> 就是两个词，绝不合并（否则整行会粘成一个大框，后面的词就选不到了）
        const bothDict = acc.text.length >= 2 && nx.text.length >= 2 &&
          inDict(acc.text) && inDict(nx.text);
        const limit = (acc.text.length === 1 || nx.text.length === 1)
          ? Math.max(2, charW * 1.6)
          : Math.max(1.5, charW * 0.5);
        if (!bothDict && gap <= limit && gap < heightOf(acc.bbox) * 0.9) {
          acc = {
            text: acc.text + nx.text,
            bbox: {
              x0: Math.min(acc.bbox.x0 || 0, nx.bbox.x0 || 0),
              y0: Math.min(acc.bbox.y0 || 0, nx.bbox.y0 || 0),
              x1: Math.max(acc.bbox.x1 || 0, nx.bbox.x1 || 0),
              y1: Math.max(acc.bbox.y1 || 0, nx.bbox.y1 || 0)
            },
            conf: Math.min(acc.conf || 0, nx.conf || 0),
            selected: false
          };
        } else {
          out.push(acc); acc = nx;
        }
      }
      out.push(acc);
    });
    return out;
  }

  /* ======================================================================
   * 自定义圈选：只识别框内区域
   * ==================================================================== */
  /** 把「百分比矩形」从原图裁出来并放大，返回 canvas */
  function cropRegion(r) {
    const img = state.img;
    if (!img) return null;
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (!iw || !ih) return null;
    const sx = Math.max(0, Math.round(r.x0 / 100 * iw));
    const sy = Math.max(0, Math.round(r.y0 / 100 * ih));
    const sw = Math.min(iw - sx, Math.max(4, Math.round((r.x1 - r.x0) / 100 * iw)));
    const sh = Math.min(ih - sy, Math.max(4, Math.round((r.y1 - r.y0) / 100 * ih)));
    if (sw <= 2 || sh <= 2) return null;

    // 小区域要放大到便于识别的高度（约 150px 的字高效果最好）
    const k = Math.min(8, Math.max(1, 150 / Math.max(1, sh)));
    const cv = document.createElement('canvas');
    cv.width = Math.min(2600, Math.round(sw * k));
    cv.height = Math.min(1600, Math.round(sh * k));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    enhance(cv, ctx);
    return cv;
  }

  /** 从文本里挑出像样的英文单词（cap 限制条数，默认 5） */
  function tokensOf(txt, conf, cap) {
    return String(txt || '')
      .split(/[^A-Za-z'\-]+/)
      .map(s => s.replace(/^['\-]+|['\-]+$/g, '').toLowerCase())
      .filter(s => s.length >= 2 && !isNoise(s, conf))
      .slice(0, cap || 5);
  }

  /** 合并两次识别的单词（保序去重） */
  function unionTokens(a, b) {
    const out = a.slice();
    (b || []).forEach(t => { if (out.indexOf(t) < 0) out.push(t); });
    return out;
  }

  function blobOf(cv) {
    return new Promise((resolve, reject) => {
      try {
        cv.toBlob(b => b ? resolve(b) : reject(new Error('裁剪失败')), 'image/png');
      } catch (e) { reject(e); }
    });
  }

  /** 拿到可复用的 worker（没有就现建一个） */
  function getWorker(status) {
    if (state.worker) return Promise.resolve(state.worker);
    return Promise.all([loadEngine(), buildCfgs()])
      .then(([T, cfgs]) => createWorkerSmart(T, cfgs, 0, status || function () { }))
      .then(w => { state.worker = w; return w; });
  }

  function dropWorker() {
    if (state.worker) {
      try { state.worker.terminate(); } catch (e) { }
      state.worker = null;
    }
  }

  /**
   * 识别一个自定义圈选区
   * @param {Object} r {x0,y0,x1,y1} 百分比
   * @param {Function} onStatus
   * @returns {Promise<{words:string[], cjk:boolean}>}
   */
  function recognizeRegion(r, onStatus) {
    const status = onStatus || function () { };
    const cv = cropRegion(r);
    if (!cv) return Promise.resolve({ words: [], cjk: false });

    status('正在识别圈选区域…');
    return loadEngine()
      .then(() => getWorker(status))
      .then(worker => blobOf(cv).then(blob => ({ worker: worker, blob: blob })))
      .then(ctx => {
        return setParams(ctx.worker, '8', WHITELIST)          // ① 单词模式（单个词最准）
          .then(() => Promise.resolve(ctx.worker.recognize(ctx.blob)))
          .then(res => tokensOf((res && res.data && res.data.text) || '',
            (res && res.data && res.data.confidence) || 0, 40))
          // ② 再按「整块文字」扫一遍：圈到一整行/一整段时，①只能吐出第一个词，
          //    这一遍把同一区域里剩下的单词都补齐（短文最常栽在这里）
          .then(t1 => setParams(ctx.worker, '6', WHITELIST)
            .then(() => Promise.resolve(ctx.worker.recognize(ctx.blob)))
            .then(res => tokensOf((res && res.data && res.data.text) || '',
              (res && res.data && res.data.confidence) || 0, 40))
            .catch(() => [])
            .then(t2 => unionTokens(t1, t2)))
          .then(tokens => {
            if (tokens.length) return { words: tokens, cjk: false };
            // ③ 英文没结果：放开字符限制再看一眼，判断是不是圈到中文了
            return setParams(ctx.worker, '7')
              .then(() => Promise.resolve(ctx.worker.recognize(ctx.blob)))
              .then(res2 => {
                const text2 = (res2 && res2.data && res2.data.text) || '';
                const cjk = CJK_RE.test(text2);
                const tk = tokensOf(text2, (res2 && res2.data && res2.data.confidence) || 0, 40);
                return { words: tk, cjk: cjk && !tk.length };
              })
              .catch(() => ({ words: [], cjk: false }));
          })
          .catch(() => ({ words: [], cjk: false }));
      })
      .catch(e => {
        console.warn('[ocr] 圈选识别失败', e);
        return { words: [], cjk: false };
      });
  }

  /* ---------------- 圈选区管理 ---------------- */
  function sameRegion(a, b) {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const sa = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
    return (ix * iy) / sa > 0.5;
  }

  function addRegion(r) {
    // 与已有选区大面积重叠 -> 视为在调整同一个框
    for (let i = 0; i < state.regions.length; i++) {
      if (sameRegion(state.regions[i], r)) {
        state.regions[i].x0 = r.x0; state.regions[i].y0 = r.y0;
        state.regions[i].x1 = r.x1; state.regions[i].y1 = r.y1;
        state.activeId = state.regions[i].id;
        return state.regions[i];
      }
    }
    const rg = {
      id: state.nextId++, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
      words: [], busy: false
    };
    state.regions.push(rg);
    state.activeId = rg.id;
    return rg;
  }

  function removeRegion(id) {
    state.regions = state.regions.filter(r => r.id !== id);
    if (state.activeId === id) state.activeId = 0;
    state.words = state.words.filter(w => w.rid !== id);
    renderRegions();
    syncBoxesClass();
    emit();
  }

  function clearRegions() {
    state.regions = [];
    state.activeId = 0;
    state.words = state.words.filter(w => !w.custom);
    renderRegions();
    syncBoxesClass();
    emit();
  }

  function setActive(id) {
    state.activeId = id;
    renderRegions();
  }

  /** 把圈选区识别出的词写回 state.words（custom 词条永远选中） */
  function applyRegionWords(rg, words) {
    state.words = state.words.filter(w => w.rid !== rg.id);
    rg.words = words || [];
    rg.words.forEach(t => {
      state.words.push({
        text: t,
        bbox: {
          x0: rg.x0 / 100 * (state.natural.w || 1), y0: rg.y0 / 100 * (state.natural.h || 1),
          x1: rg.x1 / 100 * (state.natural.w || 1), y1: rg.y1 / 100 * (state.natural.h || 1)
        },
        conf: 92,
        selected: true,
        custom: true,
        rid: rg.id
      });
    });
    syncBoxesClass();
  }

  /** 识别一个圈选区并把结果落到词条上 */
  function runRegion(rg, onStatus) {
    if (rg.busy) return Promise.resolve();
    rg.busy = true;
    renderRegions();
    return recognizeRegion(rg, onStatus).then(res => {
      rg.busy = false;
      applyRegionWords(rg, res.words);
      renderRegions();
      emit(res.words.length ? null : (res.cjk
        ? '这个框里是中文，请只圈选英文单词'
        : '没识别出英文，把框放大一点或重新拍照'));
      return res;
    }).catch(e => {
      rg.busy = false;
      renderRegions();
      return { words: [], cjk: false };
    });
  }

  /* ---------------- 渲染圈选区 ---------------- */
  function renderRegions() {
    const layer = state.regionLayer;
    if (!layer) return;
    layer.innerHTML = '';
    state.regions.forEach(rg => {
      const active = rg.id === state.activeId;
      const box = u.el('div', {
        class: 'ocr-region' + (active ? ' active' : '') + (rg.busy ? ' busy' : ''),
        dataset: { rid: String(rg.id) },
        style: 'left:' + rg.x0 + '%;top:' + rg.y0 + '%;width:' + Math.max(0.5, rg.x1 - rg.x0) +
          '%;height:' + Math.max(0.5, rg.y1 - rg.y0) + '%'
      });
      const label = rg.words.length
        ? (rg.words.slice(0, 3).join(' / ') + (rg.words.length > 3 ? ' …共' + rg.words.length + '词' : ''))
        : (rg.busy ? '识别中…' : '未识别');
      box.appendChild(u.el('span', { class: 'ocr-region-tag', text: label }));
      box.appendChild(u.el('button', {
        class: 'ocr-region-del', html: '&times;', title: '删除这个圈选',
        onpointerdown: ev => { ev.stopPropagation(); },
        onclick: ev => { ev.stopPropagation(); removeRegion(rg.id); }
      }));
      if (active) {
        ['nw', 'ne', 'sw', 'se'].forEach(h => {
          box.appendChild(u.el('i', { class: 'ocr-h h-' + h, dataset: { h: h } }));
        });
      }
      layer.appendChild(box);
    });
  }

  /* ======================================================================
   * 图片缩放 / 平移 / 圈选
   * ==================================================================== */
  function dispSize() {
    const w = (state.vp && state.vp.clientWidth) || 1;
    const nw = state.natural.w || 1, nh = state.natural.h || 1;
    return { w: w, h: w * nh / nw };
  }

  function minScale() {
    const vp = state.vp;
    if (!vp) return 1;
    const d = dispSize();
    const vpH = vp.clientHeight || 1;
    return Math.min(1, vpH / Math.max(1, d.h));
  }

  function clampView() {
    const vp = state.vp;
    if (!vp) return;
    const v = state.view;
    const vpW = vp.clientWidth || 1, vpH = vp.clientHeight || 1;
    const d = dispSize();
    v.scale = Math.min(8, Math.max(minScale(), v.scale));
    const sw = d.w * v.scale, sh = d.h * v.scale;
    v.tx = sw <= vpW ? (vpW - sw) / 2 : Math.min(0, Math.max(vpW - sw, v.tx));
    v.ty = sh <= vpH ? (vpH - sh) / 2 : Math.min(0, Math.max(vpH - sh, v.ty));
  }

  function applyView() {
    if (!state.scene) return;
    const v = state.view;
    state.scene.style.transform = 'translate(' + v.tx + 'px,' + v.ty + 'px) scale(' + v.scale + ')';
    // 圈选框的边框 / 把手 / 文字不跟着一起被放大
    state.scene.style.setProperty('--is', String(1 / (v.scale || 1)));
    if (state.onZoom) state.onZoom(v.scale);
  }

  function resetView() {
    state.view = { scale: 1, tx: 0, ty: 0 };
    clampView();
    applyView();
  }

  /** 以某个屏幕点为锚缩放 */
  function zoomAt(factor, clientX, clientY) {
    const vp = state.vp;
    if (!vp) return;
    const v = state.view;
    const r = vp.getBoundingClientRect();
    const px = (clientX === undefined ? r.left + r.width / 2 : clientX) - r.left;
    const py = (clientY === undefined ? r.top + r.height / 2 : clientY) - r.top;
    const ns = Math.min(8, Math.max(minScale(), v.scale * factor));
    const k = ns / v.scale;
    v.tx = px - (px - v.tx) * k;
    v.ty = py - (py - v.ty) * k;
    v.scale = ns;
    clampView();
    applyView();
  }

  function zoomBy(factor) { zoomAt(factor); }

  /** 整页适应（缩小到能看全整张图） */
  function fitAll() {
    state.view.scale = minScale();
    state.view.tx = 0; state.view.ty = 0;
    clampView();
    applyView();
  }

  function setMode(mode) {
    state.mode = (mode === 'pan') ? 'pan' : 'select';
    if (state.vp) state.vp.dataset.mode = state.mode;
  }

  /** 绑定缩放 / 平移 / 圈选（只绑一次） */
  function bindStage(refs, onChange) {
    const vp = refs.viewport, scene = refs.scene;
    if (!vp || !scene) return;
    state.vp = vp; state.scene = scene;
    state.marquee = refs.marquee || scene.querySelector('.ocr-marquee');
    state.regionLayer = refs.regionLayer || scene.querySelector('.ocr-regions');
    if (refs.onZoom) state.onZoom = refs.onZoom;
    state.onChange = onChange || state.onChange;
    if (vp.dataset.stageBound === '1') { resetView(); return; }
    vp.dataset.stageBound = '1';
    vp.dataset.mode = state.mode;

    const marquee = state.marquee;
    const pointers = new Map();
    let startScene = null, startClient = null, moved = false;
    let pinch = null, panStart = null;
    let drag = null;                 // {rid, type:'move'|'nw'|'ne'|'sw'|'se', start, rect}

    function toScene(clientX, clientY) {
      const r = vp.getBoundingClientRect();
      const v = state.view;
      return {
        x: (clientX - r.left - v.tx) / v.scale,
        y: (clientY - r.top - v.ty) / v.scale
      };
    }
    function toPct(p) {
      const d = dispSize();
      return {
        x: Math.max(0, Math.min(100, p.x / Math.max(1, d.w) * 100)),
        y: Math.max(0, Math.min(100, p.y / Math.max(1, d.h) * 100))
      };
    }
    function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }
    function findRegion(id) {
      for (let i = 0; i < state.regions.length; i++) if (state.regions[i].id === id) return state.regions[i];
      return null;
    }

    /* --- 圈选区：点把手 / 框体 = 调整，不启动画新框 --- */
    if (state.regionLayer && state.regionLayer.dataset.bound !== '1') {
      state.regionLayer.dataset.bound = '1';
      state.regionLayer.addEventListener('pointerdown', function (ev) {
        const rgEl = ev.target.closest ? ev.target.closest('.ocr-region') : null;
        if (!rgEl) return;
        const del = ev.target.closest ? ev.target.closest('.ocr-region-del') : null;
        if (del) return;                       // 删除按钮自己处理
        ev.stopPropagation();
        const rg = findRegion(parseInt(rgEl.dataset.rid, 10));
        if (!rg) return;
        const hEl = ev.target.closest ? ev.target.closest('.ocr-h') : null;
        drag = {
          rid: rg.id,
          type: hEl ? hEl.dataset.h : 'move',
          start: toScene(ev.clientX, ev.clientY),
          rect: { x0: rg.x0, y0: rg.y0, x1: rg.x1, y1: rg.y1 }
        };
        state.activeId = rg.id;
        renderRegions();
        try { vp.setPointerCapture(ev.pointerId); } catch (e) { }
      });
    }

    function moveDrag(ev) {
      const rg = findRegion(drag.rid);
      if (!rg) return;
      const p = toPct(toScene(ev.clientX, ev.clientY));
      const s = toPct(drag.start);
      const dx = p.x - s.x, dy = p.y - s.y;
      const r0 = drag.rect;
      if (drag.type === 'move') {
        let nx0 = Math.max(0, Math.min(100 - (r0.x1 - r0.x0), r0.x0 + dx));
        let ny0 = Math.max(0, Math.min(100 - (r0.y1 - r0.y0), r0.y0 + dy));
        rg.x0 = nx0; rg.y0 = ny0;
        rg.x1 = nx0 + (r0.x1 - r0.x0); rg.y1 = ny0 + (r0.y1 - r0.y0);
      } else {
        let x0 = r0.x0, y0 = r0.y0, x1 = r0.x1, y1 = r0.y1;
        if (drag.type.indexOf('n') === 0) y0 = Math.min(r0.y1 - 1, p.y);
        if (drag.type.indexOf('s') === 0) y1 = Math.max(r0.y0 + 1, p.y);
        if (drag.type.indexOf('w') > 0 || drag.type === 'nw' || drag.type === 'sw') x0 = Math.min(r0.x1 - 1, p.x);
        if (drag.type === 'ne' || drag.type === 'se') x1 = Math.max(r0.x0 + 1, p.x);
        rg.x0 = x0; rg.y0 = y0; rg.x1 = x1; rg.y1 = y1;
      }
      renderRegions();
    }

    let rerunTimer = null;
    function endDrag() {
      const rg = findRegion(drag.rid);
      drag = null;
      if (!rg) return;
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(function () { runRegion(rg); }, 260);
    }

    /* 轻点（没怎么移动、时间又短）= 切换最近单词的勾选状态
       —— 不做任何命中判定细致的 DOM 命中，手指落在单词附近的任何位置都算，
       解决「框太小点不到 / 框被别的框压住」这两种顽疾 */
    const DRAG_MIN = 16;    // 超过 16px 才算拖动（以前 8px，手指轻抖就被当成拖框了）
    const TAP_MAX_MS = 500;
    let tapStart = null;

    function wordAtScene(p) {
      const d = dispSize();
      if (!d.w || !d.h || !state.natural.w || !state.natural.h) return null;
      const kx = d.w / state.natural.w, ky = d.h / state.natural.h;
      const cands = [];
      state.words.forEach(w => {
        if (!w.text || !/[a-z]/i.test(w.text) || w.custom) return;
        const b = w.bbox || {};
        const x0 = (b.x0 || 0) * kx, y0 = (b.y0 || 0) * ky;
        const x1 = (b.x1 || 0) * kx, y1 = (b.y1 || 0) * ky;
        const h = Math.max(1, y1 - y0);
        // 手指到这个框的距离（落在框内就是 0）
        const dx = Math.max(x0 - p.x, 0, p.x - x1);
        const dy = Math.max(y0 - p.y, 0, p.y - y1);
        const gap = Math.sqrt(dx * dx + dy * dy);
        if (gap > Math.max(24, h * 1.1)) return;                 // 太远，不算
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const cd = Math.sqrt((cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y));
        // 落在框里 > 落在边缘缓冲上 > 纯粹离得近
        const rank = gap === 0 ? 0 : (gap <= Math.max(6, h * 0.35) ? 1 : 2);
        cands.push({ w: w, rank: rank, cd: cd });
      });
      if (!cands.length) return null;
      cands.sort((a, b) => (a.rank - b.rank) || (a.cd - b.cd));
      return cands[0].w;
    }
    state.wordAtScene = wordAtScene;   // 供调试 / 自动化检查

    function handleTap(clientX, clientY) {
      if (state.running) { emit('整张图还在识别，稍等一下'); return; }
      const p = toScene(clientX, clientY);
      const w = wordAtScene(p);
      if (!w) {
        emit('这里没有单词 —— 按住手指在单词上<b>拖出方框</b>可以重新圈选识别');
        return;
      }
      w.selected = !w.selected;
      syncBoxesClass();
      emit();
      u.toast((w.selected ? '已选中 ' : '已取消 ') + w.text, 1100);
    }

    vp.addEventListener('pointerdown', function (ev) {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      tapStart = { x: ev.clientX, y: ev.clientY, t: Date.now() };
      try { vp.setPointerCapture(ev.pointerId); } catch (e) { }
      if (pointers.size >= 2) {
        const pts = [];
        pointers.forEach(p => pts.push(p));
        pinch = { d: dist(pts[0], pts[1]) };
        startScene = null; moved = false;
        if (marquee) marquee.hidden = true;
      } else {
        startScene = toScene(ev.clientX, ev.clientY);
        startClient = { x: ev.clientX, y: ev.clientY };
        moved = false;
        if (state.mode === 'select' && marquee) {
          marquee.hidden = true;
          marquee.style.left = startScene.x + 'px';
          marquee.style.top = startScene.y + 'px';
          marquee.style.width = '0px';
          marquee.style.height = '0px';
        } else {
          panStart = { x: ev.clientX, y: ev.clientY, tx: state.view.tx, ty: state.view.ty };
        }
      }
    });

    vp.addEventListener('pointermove', function (ev) {
      // 调整已有圈选框
      if (drag) {
        moveDrag(ev);
        if (ev.cancelable) ev.preventDefault();
        return;
      }
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

      if (pinch && pointers.size >= 2) {
        const pts = [];
        pointers.forEach(p => pts.push(p));
        const d = dist(pts[0], pts[1]);
        if (pinch.d > 4 && d > 4) {
          zoomAt(d / pinch.d, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
          pinch.d = d;
        }
        if (ev.cancelable) ev.preventDefault();
        return;
      }

      if (state.mode === 'pan' && panStart) {
        state.view.tx = panStart.tx + (ev.clientX - panStart.x);
        state.view.ty = panStart.ty + (ev.clientY - panStart.y);
        clampView(); applyView();
        if (ev.cancelable) ev.preventDefault();
        return;
      }

      if (state.mode === 'select' && startScene && marquee) {
        const dxClient = ev.clientX - startClient.x, dyClient = ev.clientY - startClient.y;
        // ★ 超过 16px 才算「拖框」：手指轻点时的微小抖动不再被当成圈选
        if (!moved && Math.abs(dxClient) < DRAG_MIN && Math.abs(dyClient) < DRAG_MIN) return;
        moved = true;
        if (ev.cancelable) ev.preventDefault();
        const p = toScene(ev.clientX, ev.clientY);
        marquee.hidden = false;
        marquee.style.left = Math.min(startScene.x, p.x) + 'px';
        marquee.style.top = Math.min(startScene.y, p.y) + 'px';
        marquee.style.width = Math.abs(p.x - startScene.x) + 'px';
        marquee.style.height = Math.abs(p.y - startScene.y) + 'px';
      }
    });

    function endPointer(ev) {
      if (drag) { endDrag(); }
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;

      // ★ 没拖动 + 抬手很快 = 轻点 -> 切换离手指最近那个单词的勾选
      if (tapStart && !moved && !pointers.size && Date.now() - tapStart.t <= TAP_MAX_MS) {
        handleTap(ev.clientX, ev.clientY);
      }
      tapStart = null;

      if (state.mode === 'select' && startScene && moved && marquee) {
        const x = parseFloat(marquee.style.left) || 0;
        const y = parseFloat(marquee.style.top) || 0;
        const w = parseFloat(marquee.style.width) || 0;
        const h = parseFloat(marquee.style.height) || 0;
        marquee.hidden = true;
        const d = dispSize();
        if (!state.natural.w || !state.natural.h) {
          emit(state.running ? '整张图还在识别，稍等一下再圈选' : '请先拍一张图片');
        } else if (d.w > 0 && d.h > 0 && (w > 0 || h > 0)) {
          const a = toPct({ x: x, y: y });
          const b = toPct({ x: x + w, y: y + h });
          const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
          if ((rect.x1 - rect.x0) >= 1 && (rect.y1 - rect.y0) >= 0.8) {
            const rg = addRegion(rect);
            renderRegions();
            runRegion(rg);
          } else {
            emit('框太小了，放大图片后再圈一次');
          }
        }
      }
      if (marquee) marquee.hidden = true;
      startScene = null; startClient = null; panStart = null; moved = false;
    }

    // 已经做了 setPointerCapture，抬手/取消一定会回到这里，无需 pointerleave
    vp.addEventListener('pointerup', endPointer);
    vp.addEventListener('pointercancel', endPointer);

    // 滚轮缩放（电脑端）
    vp.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      const f = ev.deltaY < 0 ? 1.18 : 1 / 1.18;
      zoomAt(f, ev.clientX, ev.clientY);
    }, { passive: false });

    // 双击：在 1 倍与 2.5 倍之间切换
    vp.addEventListener('dblclick', function (ev) {
      const target = state.view.scale > 1.4 ? 1 : 2.5;
      zoomAt(target / state.view.scale, ev.clientX, ev.clientY);
    });

    window.addEventListener('resize', function () { clampView(); applyView(); });
    resetView();
  }

  /* ---------------- 渲染图片上的选择框 ---------------- */
  function boxArea(w) {
    const b = w.bbox || {};
    return Math.max(1, ((b.x1 || 0) - (b.x0 || 0)) * ((b.y1 || 0) - (b.y0 || 0)));
  }
  /** 需要画框的词。按面积从大到小排：小框叠在上层，密集重叠时点中的总是更贴合的那个 */
  function visibleWords() {
    return state.words
      .filter(w => w.text && /[a-z]/i.test(w.text) && !w.custom)
      .sort((a, b) => boxArea(b) - boxArea(a));
  }

  function renderBoxes(wrap, imgEl, onChange) {
    const boxLayer = (wrap && wrap.querySelector('.ocr-boxes')) || u.$('#ocrBoxes');
    if (!boxLayer) return;
    boxLayer.innerHTML = '';
    const nw = state.natural.w || 1, nh = state.natural.h || 1;
    if (imgEl) imgEl.src = state.imgUrl;

    visibleWords().forEach((w) => {
      const b = w.bbox || {};
      const left = (b.x0 || 0) / nw * 100;
      const top = (b.y0 || 0) / nh * 100;
      const width = Math.max(1.2, ((b.x1 || 0) - (b.x0 || 0)) / nw * 100);
      const height = Math.max(2.2, ((b.y1 || 0) - (b.y0 || 0)) / nh * 100);
      // 框只是显示用，点击统一由「点最近的单词」处理（见 bindStage 的 handleTap）
      const box = u.el('div', {
        class: 'ocr-box' + (w.selected ? ' on' : ''),
        title: w.text + '（置信度 ' + Math.round(w.conf || 0) + '%）',
        style: 'left:' + left + '%;top:' + top + '%;width:' + width + '%;height:' + height + '%'
      });
      boxLayer.appendChild(box);
    });

    const vp = (wrap && wrap.querySelector('.ocr-viewport')) || wrap;
    const scene = (wrap && wrap.querySelector('.ocr-scene')) || wrap;
    bindStage({
      viewport: vp, scene: scene, marquee: u.$('#ocrMarquee'),
      regionLayer: scene.querySelector('.ocr-regions')
    }, onChange);
    renderRegions();
  }

  /** 选中矩形区域内的自动识别单词（百分比坐标），采用中心点判定，返回本次命中数量 */
  function selectInRect(x0, y0, x1, y1) {
    const nw = state.natural.w || 1, nh = state.natural.h || 1;
    let n = 0;
    state.words.forEach(w => {
      if (w.custom) return;
      const b = w.bbox || {};
      const cx = (((b.x0 || 0) + (b.x1 || 0)) / 2) / nw * 100;
      const cy = (((b.y0 || 0) + (b.y1 || 0)) / 2) / nh * 100;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
        w.selected = true;
        n++;
      }
    });
    syncBoxesClass();
    return n;
  }

  /** 把选中状态同步到 DOM（拖框后无需重绘整层），顺序须与渲染一致 */
  function syncBoxesClass() {
    const boxes = document.querySelectorAll('.ocr-box');
    visibleWords().forEach((w, i) => {
      const el = boxes[i];
      if (el) el.classList.toggle('on', !!w.selected);
    });
  }

  function emit(msg) {
    if (state.onChange) state.onChange(getSelected(), msg);
  }

  function clearSelection() {
    state.words.forEach(w => { w.selected = false; });
    syncBoxesClass();
  }

  /** 参与「全选 / 反选」的词：只要含字母就算（和画框的范围保持一致，不再漏掉短单词） */
  function pickable(w) { return !!w && !!w.text && /[a-z]/i.test(w.text) && !w.custom; }

  function setAll(flag) {
    state.words.forEach(w => { if (pickable(w)) w.selected = !!flag; });
    syncBoxesClass();
  }

  /** 反选：没勾的勾上、勾上的取消（单词多时比「全选再一个个点掉」省事）
   *  圈选出来的词保持选中，不参与反选 */
  function invertSelection() {
    state.words.forEach(w => {
      if (!pickable(w)) return;
      w.selected = !w.selected;
    });
    syncBoxesClass();
    return getSelected().length;
  }

  function getSelected() {
    const out = [];
    state.words.forEach(w => {
      if (w.selected && w.text && out.indexOf(w.text) < 0) out.push(w.text);
    });
    return out;
  }

  /** 已选词条（含来源信息，方便界面上区分「圈选的」和「自动识别的」） */
  function getSelectedItems() {
    const out = [];
    state.words.forEach(w => {
      if (!w.selected || !w.text) return;
      if (out.some(x => x.text === w.text)) return;
      out.push({ text: w.text, custom: !!w.custom, rid: w.rid || 0, conf: Math.round(w.conf || 0) });
    });
    return out;
  }

  /** 修改某个已选词的文本（识别错了可以手改） */
  function updateWordText(oldText, newText) {
    const from = String(oldText || '').toLowerCase();
    const to = String(newText || '').toLowerCase().replace(/[^a-z'\- ]/g, '').trim();
    if (!to) return false;
    let hit = false;
    state.words.forEach(w => {
      if (w.text === from) { w.text = to; hit = true; }
    });
    state.regions.forEach(rg => {
      rg.words = rg.words.map(t => (t === from ? to : t));
    });
    if (hit) { renderRegions(); emit(); }
    return hit;
  }

  function removeWord(text) {
    const key = String(text || '').toLowerCase();
    let hit = false;
    state.words.forEach(w => { if (w.text === key) { w.selected = false; hit = true; } });
    state.regions.forEach(rg => { rg.words = rg.words.filter(t => t !== key); });
    if (hit) { renderRegions(); syncBoxesClass(); }
    return hit;
  }

  function unselectWord(text) { return removeWord(text); }

  function reset() {
    dropWorker();
    if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
    state.file = null; state.imgUrl = ''; state.words = []; state.natural = { w: 0, h: 0 };
    state.img = null; state.gray = null;
    state.regions = []; state.activeId = 0;
    if (state.regionLayer) state.regionLayer.innerHTML = '';
    resetView();
  }

  SM.ocr = {
    state, recognize, renderBoxes, setAll, getSelected, getSelectedItems, reset,
    clearSelection, invertSelection,
    selectInRect, unselectWord, removeWord, updateWordText,
    replaceEngine, loadEngine, postProcess, qualityOf, isNoise, tokensOf, mergePasses,
    splitStuckWords, invertSelection, clearSelection, getSelectedItems,
    bindStage, zoomBy, zoomAt, fitAll, resetView, setMode,
    recognizeRegion, addRegion, removeRegion, clearRegions, runRegion, renderRegions,
    setZoomListener: function (fn) { state.onZoom = fn; if (fn) fn(state.view.scale); },
    get mode() { return state.mode; },
    get scale() { return state.view.scale; },
    get imgUrl() { return state.imgUrl; },
    get regionCount() { return state.regions.length; },
    get wordCount() { return state.words.filter(w => /^[a-z]{2,}$/i.test(w.text)).length; }
  };
})(window.SM);
