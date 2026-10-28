/* ==========================================================================
 * speech.js —— 单词朗读（TTS）
 *   · 首选：浏览器内置 Web Speech API（离线可用，但部分手机没有英文语音包）
 *   · 兜底：有道真人发音音频（走本地服务 /api/tts 代理，跨域与网络都可控）
 *   · 看门狗：点了喇叭 1.4 秒内没真正出声，自动切在线真人发音
 * 常见问题与对策（本次修复）：
 *   1) 安卓 / 微信内置浏览器缺英文语音包 -> 静默失败            -> 兜底在线音频
 *   2) Chrome 桌面版 cancel() 后立刻 speak() 会被吞掉          -> 队列忙时延迟再播
 *   3) utterance 被 GC 导致话说到一半断掉                      -> 持有全局引用
 *   4) voices 异步就绪，首次点选不到音色                        -> 启动时轮询预热
 * ========================================================================== */
(function (SM) {
  'use strict';

  const synth = window.speechSynthesis || null;

  let voices = [];
  let voicesReady = false;
  let audioEl = null;
  let keepUtt = null;          // 防 GC（Chrome 已知问题）
  let watchdog = null;

  /** 是否支持语音合成 */
  function supported() {
    return !!synth && typeof window.SpeechSynthesisUtterance === 'function';
  }

  /** 取一次音色列表（浏览器可能异步就绪，需反复取） */
  function refreshVoices() {
    if (!synth) return voices;
    try {
      const v = synth.getVoices() || [];
      if (v.length) { voices = v; voicesReady = true; }
    } catch (e) { /* 忽略 */ }
    return voices;
  }

  if (supported()) {
    refreshVoices();
    if ('onvoiceschanged' in synth) synth.onvoiceschanged = refreshVoices;
    // 部分浏览器只触发一次 onvoiceschanged 且很晚，这里再兜一层轮询
    let tries = 0;
    const t = setInterval(function () {
      refreshVoices();
      if (voicesReady || ++tries > 25) clearInterval(t);
    }, 300);
  }

  /** 获取首选音色（按口音匹配） */
  function pickVoice(accent) {
    refreshVoices();
    if (!voices.length) return null;
    const want = accent || (SM.store && SM.store.getSettings().accent) || 'en-US';
    const wantLang = String(want).replace('_', '-');
    // 1) 精确匹配 lang
    let v = voices.find(x => x.lang && String(x.lang).replace('_', '-') === wantLang);
    // 2) 同前缀（en-US -> en-GB 也能用）
    if (!v) v = voices.find(x => x.lang && String(x.lang).toLowerCase().indexOf(wantLang.slice(0, 2)) === 0);
    // 3) 任意英文
    if (!v) v = voices.find(x => /^en/i.test(x.lang || ''));
    if (v) return v;
    // 4) 本地常见的高质量英文音色名
    return voices.find(x => /google|natural|samantha|daniel|zira|hazel|aria|jenny/i.test(x.name || '')) || null;
  }

  /* ---------------- 在线真人发音（兜底） ---------------- */
  /** 有道发音地址：本机走服务代理，公网版直连（少一次必然 404 的请求） */
  function ttsUrls(word, accent) {
    const w = encodeURIComponent(String(word || '').trim());
    const type = /en-gb|uk|brit/i.test(String(accent || '')) ? '2' : '1';
    const direct = 'https://dict.youdao.com/dictvoice?audio=' + w + '&type=' + type;
    const h = location.hostname || '';
    if (isPrivateHostHTTP(h) || location.protocol === 'file:') {
      return ['api/tts?word=' + w + '&type=' + type, direct];   // 本机/局域网：优先走服务代理
    }
    return [direct];                                            // 公网（含 Pages）：直连有道
  }

  /** 是否本机或局域网访问（这类场景同域往往就跑着 server.js） */
  function isPrivateHostHTTP(h) {
    if (!h) return true;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(h)) return true;
    if (/^(192\.168\.|10\.)/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;      // 172.16.0.0/12
    return false;
  }

  function ensureAudio() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = 'auto';
      // 手机微信/部分浏览器需要这个属性才允许不经手势播放
      try { audioEl.setAttribute('playsinline', ''); } catch (e) { }
    }
    return audioEl;
  }

  function playUrl(url, onOk, onFail) {
    try {
      const a = ensureAudio();
      let settled = false;
      const timer = setTimeout(function () {
        if (!settled) { settled = true; a.pause(); onFail && onFail(); }
      }, 6000);
      a.onplaying = function () { if (!settled) { settled = true; clearTimeout(timer); onOk && onOk(); } };
      a.onerror = function () { if (!settled) { settled = true; clearTimeout(timer); onFail && onFail(); } };
      a.onended = function () { if (!settled) { settled = true; clearTimeout(timer); onOk && onOk(); } };
      a.src = url;
      a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { if (!settled) { settled = true; clearTimeout(timer); onFail && onFail(); } });
      }
      return true;
    } catch (e) {
      onFail && onFail();
      return false;
    }
  }

  /** 依次尝试多个地址播放 */
  function playList(urls, i, onOk, onFail) {
    if (!urls.length || i >= urls.length) { onFail && onFail(); return false; }
    return playUrl(urls[i], onOk, function () { playList(urls, i + 1, onOk, onFail); });
  }

  /** 播放单词发音（在线真人音） */
  function playWord(word, opt) {
    opt = opt || {};
    const urls = ttsUrls(word, opt.accent);
    if (opt.audio && urls.indexOf(opt.audio) < 0) urls.unshift(opt.audio);
    return playList(urls, 0, opt.onStart, function () {
      opt.onFail && opt.onFail();
      opt.onEnd && opt.onEnd();
    });
  }

  /* ---------------- 主入口 ---------------- */
  /**
   * 朗读单词
   * @param {String} text 要朗读的内容
   * @param {Object} opt {accent, rate, times, audio, onStart, onEnd, onFail}
   */
  function speak(text, opt) {
    opt = opt || {};
    const word = String(text || '').trim();
    if (!word) { opt.onEnd && opt.onEnd(); return false; }

    const times = Math.max(1, opt.times || 1);
    const accent = opt.accent || (SM.store && SM.store.getSettings().accent) || 'en-US';
    let closed = false;
    const finish = function () { if (closed) return; closed = true; opt.onEnd && opt.onEnd(); };

    // 浏览器完全不支持语音合成 -> 直接走在线音频
    if (!supported()) {
      return playWord(word, {
        accent: accent, audio: opt.audio,
        onStart: opt.onStart, onEnd: finish, onFail: opt.onFail
      });
    }

    const voice = pickVoice(accent);
    let started = false;
    let fellBack = false;
    let n = 0;

    try {
      // 队列里有残留先清掉；Chrome 在 cancel() 后立刻 speak() 会被吞，队列忙时延迟一点
      const busy = synth.speaking || synth.pending || synth.paused;
      if (busy) {
        try { synth.cancel(); } catch (e) { }
      }
      if (synth.paused) { try { synth.resume(); } catch (e) { } }
      var delay = busy ? 120 : 0;
    } catch (e) { var delay = 0; }

    function clearWatch() {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    }

    function runOne() {
      if (closed) return;
      let utt;
      try {
        utt = new SpeechSynthesisUtterance(word);
      } catch (e) {
        fallback();
        return;
      }
      utt.lang = accent;
      utt.rate = opt.rate || 0.9;
      utt.pitch = 1;
      utt.volume = 1;
      if (voice) utt.voice = voice;
      keepUtt = utt;                                  // 持有引用，避免被回收

      utt.onstart = function () {
        started = true;
        clearWatch();
        if (n === 0) opt.onStart && opt.onStart();
      };
      utt.onend = function () {
        clearWatch();
        n++;
        if (n < times) setTimeout(runOne, 320);
        else finish();
      };
      utt.onerror = function (ev) {
        clearWatch();
        // 真机上常见：language-unavailable（没装英文语音包）/ synthesis-failed
        if (!started) { fallback(); return; }
        n++;
        if (n < times) setTimeout(runOne, 320);
        else finish();
      };

      try {
        synth.speak(utt);
      } catch (e) {
        fallback();
      }
    }

    /** TTS 出不了声 -> 换在线真人发音 */
    function fallback() {
      if (closed || fellBack) return;
      fellBack = true;
      try { synth.cancel(); } catch (e) { }
      playWord(word, {
        accent: accent, audio: opt.audio,
        onStart: opt.onStart,
        onEnd: finish,
        onFail: function () {
          opt.onFail && opt.onFail();
          finish();
        }
      });
    }

    // 看门狗：1.4 秒内没有真的出声，判定 TTS 不可用，切换在线发音
    clearWatch();
    watchdog = setTimeout(function () {
      if (!started && !closed) fallback();
    }, 1400);

    if (delay) setTimeout(runOne, delay);
    else runOne();
    return true;
  }

  function stop() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (synth) { try { synth.cancel(); } catch (e) { } }
    if (audioEl) { try { audioEl.pause(); } catch (e) { } }
  }

  /** 发音自检信息（设置页「测试发音」用） */
  function diagnose() {
    refreshVoices();
    const en = voices.filter(v => /^en/i.test(v.lang || ''));
    return {
      supported: supported(),
      paused: synth ? !!synth.paused : null,
      speaking: synth ? !!synth.speaking : null,
      voiceCount: voices.length,
      enVoiceCount: en.length,
      enVoices: en.slice(0, 4).map(v => (v.name || '?') + '（' + (v.lang || '?') + '）')
    };
  }

  SM.speech = { speak, stop, supported, pickVoice, playAudio: playWord, playWord, diagnose, ttsUrls };
})(window.SM);
