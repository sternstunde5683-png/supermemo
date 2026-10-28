/* ==========================================================================
 * server.js —— 「超级记忆」本地服务
 *   1) 静态站点托管（把本项目当网站打开）
 *   2) /api/dict 词典查询代理：由服务端去查有道 / 免费词典接口，
 *      再把结果返回给浏览器。
 *
 * 为什么需要它：
 *   浏览器直接请求 dict.youdao.com 会被跨域（CORS）拦截，而服务端请求不受限制。
 *   走本地代理后，「在线词典」不再依赖用户网络能否直连境外 API，
 *   也不再受浏览器跨域限制，查询成功率大幅提升。
 *
 * 用法：
 *   node server.js          （默认 8124 端口，被占用时自动顺延）
 *   浏览器打开 http://localhost:8124
 * ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT || 8124);

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function sendFile(req, res, filePath) {
  const abs = path.resolve(filePath);
  const root = path.resolve(ROOT);
  // 防目录穿越
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/* ---------------- 词典查询 ---------------- */
// 有道词典（数据最全：音标 + 多词性 + 中文释义 + 短语），服务端直连不受 CORS 限制
const YOUDAO = 'https://dict.youdao.com/jsonapi?q=';
// 备用：免费英文词典（音标 / 多词性 / 英文释义 / 真人发音 mp3）
const DICTAPI = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

// 简单内存缓存，避免重复请求
const cache = new Map();
const CACHE_MAX = 2000;

function fetchText(url, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout || 12000);
  return fetch(url, {
    signal: ctl.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    }
  })
    .then(r => { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .catch(e => { clearTimeout(timer); throw e; });
}

/** 解析有道返回 -> 归一化结构 */
function parseYoudao(word, j) {
  const out = { word: word, phonetic: '', property: [], explain: {}, phrase: [], example: [], audio: '', source: 'youdao' };
  try {
    const ec = j.ec && j.ec.word && j.ec.word[0];
    if (ec) {
      const ph = ec.usphone || ec.ukphone || '';
      if (ph) out.phonetic = '/' + String(ph).replace(/^\/|\/$/g, '') + '/';
      const ex = {};
      (ec.trs || []).forEach(tr => {
        const item = tr.tr && tr.tr[0];
        const line = item && item.l && item.l.i && item.l.i[0];
        if (!line) return;
        const m = String(line).match(/^([a-z]+\.)\s*(.*)$/i);
        const pos = m ? m[1].toLowerCase() : 'other';
        const def = m ? m[2] : line;
        const defs = String(def).split(/[；;]/).map(s => s.trim()).filter(s => s && s.length < 60).slice(0, 4);
        if (defs.length) ex[pos] = (ex[pos] || []).concat(defs).slice(0, 4);
      });
      out.property = Object.keys(ex);
      out.explain = ex;
    }
    if (!out.phonetic && j.simple && j.simple.word && j.simple.word[0]) {
      const ph = j.simple.word[0].usphone || j.simple.word[0].ukphone || '';
      if (ph) out.phonetic = '/' + String(ph).replace(/^\/|\/$/g, '') + '/';
    }
    // 常考短语 / 固定搭配
    const phrs = j.phrs && j.phrs.phrs;
    (phrs || []).slice(0, 6).forEach(p => {
      const head = p.phr && p.phr.headword && p.phr.headword.l && p.phr.headword.l.i;
      const trs = p.phr && p.phr.trs && p.phr.trs[0] && p.phr.trs[0].tr
        && p.phr.trs[0].tr.l && p.phr.trs[0].tr.l.i;
      if (head && trs) out.phrase.push(String(head) + ' ' + String(trs));
    });
    // 真人发音（有道公开的朗读接口，type=1 美音 / type=2 英音）
    out.audio = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=1';
    // 双语例句
    const blng = j.blng_sents_part || j['blng_sents_part'];
    if (blng && blng['sentence-pair']) {
      (blng['sentence-pair'] || []).slice(0, 4).forEach(sp => {
        if (sp && sp.sentence) out.example.push(String(sp.sentence).trim());
      });
    }
  } catch (e) { /* 解析异常时忽略 */ }
  return (out.property.length || out.phonetic) ? out : null;
}

/** 解析 dictionaryapi.dev 返回（备用源） */
function parseDictApi(word, arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const data = arr[0];
  const out = { word: word, phonetic: '', property: [], explain: {}, phrase: [], example: [], audio: '', source: 'dictapi' };
  (data.phonetics || []).forEach(p => {
    if (!out.phonetic && p && p.text) out.phonetic = p.text;
    if (!out.audio && p && p.audio) out.audio = p.audio;
  });
  if (!out.phonetic && data.phonetic) out.phonetic = data.phonetic;
  (data.meanings || []).forEach(m => {
    const pos = String(m.partOfSpeech || 'other').slice(0, 4).toLowerCase();
    if (out.property.indexOf(pos) < 0) out.property.push(pos);
    const defs = (m.definitions || []).slice(0, 4).map(d => {
      if (d.example && out.example.length < 4) out.example.push(d.example);
      return d.definition;
    });
    out.explain[pos] = (out.explain[pos] || []).concat(defs);
  });
  return out.property.length ? out : null;
}

/** 有道 -> 备用源，逐级查询 */
function queryWord(word) {
  return fetchText(YOUDAO + encodeURIComponent(word) + '&doctype=json&le=eng', 12000)
    .then(txt => parseYoudao(word, JSON.parse(txt)))
    .catch(() => null)
    .then(r => {
      if (r) return r;
      return fetchText(DICTAPI + encodeURIComponent(word), 10000)
        .then(txt => parseDictApi(word, JSON.parse(txt)))
        .catch(() => null);
    });
}

/* ---------------- HTTP 服务 ---------------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  // 词典接口
  if (p === '/api/dict') {
    const word = String(u.searchParams.get('word') || '').trim().toLowerCase();
    const isProbe = u.searchParams.get('probe') === '1';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (isProbe) { res.end(JSON.stringify({ __proxy: true, ok: true })); return; }
    if (!word) { res.writeHead(400); res.end(JSON.stringify({ error: 'empty word' })); return; }

    if (cache.has(word)) {
      res.end(JSON.stringify(cache.get(word)));
      return;
    }
    queryWord(word).then(data => {
      if (!data) { res.end(JSON.stringify({ word: word, notfound: true })); return; }
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(word, data);
      res.end(JSON.stringify(data));
    }).catch(e => {
      res.end(JSON.stringify({ word: word, notfound: true, error: String(e && e.message) }));
    });
    return;
  }

  /* ---------------- 朗读音频代理 ----------------
   * 浏览器的 Web Speech 在部分手机（尤其安卓 / 微信内置浏览器）没有英文语音包，
   * 点喇叭会「没声音」。这里把有道的真人发音接口代理到本地，前端用 <audio> 直接播，
   * 既绕开跨域，也不依赖用户端能否直连外网。
   * 用法：/api/tts?word=hello&type=1   （type=1 美音，type=2 英音）
   */
  if (p === '/api/tts') {
    const word = String(u.searchParams.get('word') || '').trim();
    const type = u.searchParams.get('type') === '2' ? '2' : '1';
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!word) { res.writeHead(400); res.end('empty word'); return; }
    const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + type;
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://dict.youdao.com/'
      }
    }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400'
      });
      if (r.body && typeof require('stream').Readable.fromWeb === 'function') {
        require('stream').Readable.fromWeb(r.body).pipe(res);
      } else {
        r.arrayBuffer().then(b => res.end(Buffer.from(b)));
      }
    }).catch(e => {
      res.writeHead(502); res.end('tts failed: ' + String(e && e.message));
    });
    return;
  }

  // 局域网访问地址：手机扫码面板用它来生成二维码（浏览器拿不到本机 IP）
  if (p === '/api/lan') {
    const os = require('os');
    const port = server.address() ? server.address().port : (u.searchParams.get('port') || '8124');
    const urls = [];
    Object.keys(os.networkInterfaces()).forEach(k => {
      (os.networkInterfaces()[k] || []).forEach(a => {
        if (a.family === 'IPv4' && !a.internal) urls.push('http://' + a.address + ':' + port);
      });
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ port: port, urls: urls }));
    return;
  }

  /* ------------------------------------------------------------------
   * /api/sync —— 局域网数据同步（不依赖任何云端账号）
   *   GET  拉取当前云端文档（没有则返回 404 空文档）
   *   POST 保存文档
   * 数据落在 data/sync.json，同一 WiFi 下的手机和电脑共用一份。
   * ------------------------------------------------------------------ */
  if (p === '/api/sync') {
    const dir = path.join(ROOT, 'data');
    const file = path.join(dir, 'sync.json');

    if (req.method === 'GET') {
      fs.readFile(file, 'utf8', (err, txt) => {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(txt || 'null');
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => {
        body += c;
        // 10MB 上限，防止异常请求撑爆内存
        if (body.length > 10 * 1024 * 1024) { req.destroy(); }
      });
      req.on('end', () => {
        let doc = null;
        try { doc = JSON.parse(body); } catch (e) {
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '数据格式不正确' }));
          return;
        }
        fs.mkdir(dir, { recursive: true }, mkErr => {
          if (mkErr) {
            res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: '无法创建数据目录：' + mkErr.message }));
            return;
          }
          // 先写临时文件再 atomically 重命名，避免写到一半断电导致数据损坏
          const tmp = file + '.tmp';
          fs.writeFile(tmp, JSON.stringify(doc), 'utf8', wErr => {
            if (wErr) {
              res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ error: '写入失败：' + wErr.message }));
              return;
            }
            fs.rename(tmp, file, rErr => {
              if (rErr) {
                res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: '写入失败：' + rErr.message }));
                return;
              }
              res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json; charset=utf-8'
              });
              res.end(JSON.stringify({ ok: true, size: body.length, at: Date.now() }));
            });
          });
        });
      });
      return;
    }

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
  }

  // 静态资源
  let file = decodeURIComponent(p);
  if (file === '/' || file === '') file = '/index.html';
  sendFile(req, res, path.join(ROOT, file));
});

/* ---------------- 启动（端口占用自动顺延） ---------------- */
function listen(port) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log('端口 ' + port + ' 已被占用，尝试 ' + (port + 1) + ' …');
      listen(port + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const ips = [];
    Object.keys(nets).forEach(k => (nets[k] || []).forEach(a => {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }));
    console.log('');
    console.log('  超级记忆已启动');
    console.log('  ------------------------------------------');
    console.log('  本机打开：   http://localhost:' + port);
    ips.forEach(ip => console.log('  手机/同网：   http://' + ip + ':' + port));
    console.log('  词典服务：   http://localhost:' + port + '/api/dict?word=hello');
    console.log('  ------------------------------------------');
    console.log('  关闭窗口或按 Ctrl+C 即可停止服务');
    console.log('');
  });
}
listen(START_PORT);
