/* ==========================================================================
 * dictionary.js —— 在线词典 API 接入 + 本地缓存 + 离线兜底
 *
 * 数据源（均为免费、无需 API Key 的开放接口）：
 *   1) 词典主数据   https://api.dictionaryapi.dev/api/v2/entries/en/<word>
 *      提供：国际音标 / 全部词性 / 多条英文释义 / 例句
 *   2) 中文翻译     https://api.mymemory.translated.net/get   （英文释义 -> 中文）
 *   3) 搭配短语     https://api.datamuse.com/words?rel_trg=xx （常见固定搭配共现词）
 *
 * 策略：优先读缓存 -> 联网查询 -> 查询失败时回退本地内置词典 / 只存单词
 * ========================================================================== */
(function (SM) {
  'use strict';

  const u = SM.utils;
  const KEY_CACHE = 'supermemo.dict.cache.v1';

  const API_DICT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
  const API_TRANS = 'https://api.mymemory.translated.net/get';
  const API_PHRASE = 'https://api.datamuse.com/words';

  /* ---------------- 词典缓存 ---------------- */
  let CACHE = {};
  try { CACHE = JSON.parse(localStorage.getItem(KEY_CACHE) || '{}') || {}; } catch (e) { CACHE = {}; }

  function saveCache() {
    try { localStorage.setItem(KEY_CACHE, JSON.stringify(CACHE)); }
    catch (e) { /* 容量不足时淘汰一半旧缓存 */ pruneCache(); }
  }
  function pruneCache() {
    const keys = Object.keys(CACHE);
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => delete CACHE[k]);
    try { localStorage.setItem(KEY_CACHE, JSON.stringify(CACHE)); } catch (e) { CACHE = {}; }
  }
  function cacheCount() { return Object.keys(CACHE).length; }
  function clearCache() { CACHE = {}; localStorage.removeItem(KEY_CACHE); }

  /* ---------------- 本地内置词典（无网兜底 / 快速演示） ---------------- */
  const LOCAL = {
    abandon: { phonetic: '/əˈbændən/', property: ['v.', 'n.'], explain: { 'v.': ['放弃；抛弃', '离弃；遗弃'], 'n.': ['放纵；任性'] }, phrase: ['abandon oneself to 沉溺于', 'abandon hope 放弃希望'] },
    ability: { phonetic: '/əˈbɪləti/', property: ['n.'], explain: { 'n.': ['能力；才能', '本领；才智'] }, phrase: ['the ability to do 有做…的能力', 'to the best of one\'s ability 尽某人所能'] },
    absorb: { phonetic: '/əbˈzɔːb/', property: ['v.'], explain: { 'v.': ['吸收；吸纳', '使全神贯注；使专心'] }, phrase: ['be absorbed in 专心于', 'absorb into 并入；吸收进'] },
    accept: { phonetic: '/əkˈsept/', property: ['v.'], explain: { 'v.': ['接受；认可', '承担；承认'] }, phrase: ['accept an invitation 接受邀请', 'accept responsibility 承担责任'] },
    achieve: { phonetic: '/əˈtʃiːv/', property: ['v.'], explain: { 'v.': ['实现；达到', '取得；完成'] }, phrase: ['achieve a goal 实现目标', 'achieve success 取得成功'] },
    benefit: { phonetic: '/ˈbenɪfɪt/', property: ['n.', 'v.'], explain: { 'n.': ['益处；好处', '福利；补贴'], 'v.': ['有益于；得益于'] }, phrase: ['benefit from 从…中受益', 'for the benefit of 为了…的利益'] },
    challenge: { phonetic: '/ˈtʃælɪndʒ/', property: ['n.', 'v.'], explain: { 'n.': ['挑战；难题', '质疑'], 'v.': ['向…挑战；质疑'] }, phrase: ['face a challenge 面临挑战', 'challenge sb to sth 向某人挑战'] },
    consider: { phonetic: '/kənˈsɪdə(r)/', property: ['v.'], explain: { 'v.': ['考虑；细想', '认为；把…看作'] }, phrase: ['consider doing 考虑做某事', 'be considered as 被认为是'] },
    develop: { phonetic: '/dɪˈveləp/', property: ['v.'], explain: { 'v.': ['发展；开发', '培养；形成'] }, phrase: ['develop into 发展成', 'develop a habit 养成习惯'] },
    effort: { phonetic: '/ˈefət/', property: ['n.'], explain: { 'n.': ['努力；尽力', '成果；努力的结果'] }, phrase: ['make an effort 作出努力', 'spare no effort 不遗余力'] },
    improve: { phonetic: '/ɪmˈpruːv/', property: ['v.'], explain: { 'v.': ['改进；改善', '提高；变得更好'] }, phrase: ['improve on 改进；超过', 'improve efficiency 提高效率'] },
    memory: { phonetic: '/ˈmeməri/', property: ['n.'], explain: { 'n.': ['记忆；记忆力', '回忆；记忆中的事物'] }, phrase: ['in memory of 纪念', 'from memory 凭记忆'] },
    practice: { phonetic: '/ˈpræktɪs/', property: ['n.', 'v.'], explain: { 'n.': ['练习；实践', '惯例；做法'], 'v.': ['练习；实践'] }, phrase: ['put into practice 付诸实践', 'practice doing 练习做某事'] },
    review: { phonetic: '/rɪˈvjuː/', property: ['n.', 'v.'], explain: { 'n.': ['复习；回顾', '评论；审查'], 'v.': ['复习；回顾', '评论；检阅'] }, phrase: ['review for 为…复习', 'under review 在审查中'] },
    succeed: { phonetic: '/səkˈsiːd/', property: ['v.'], explain: { 'v.': ['成功；达成', '继承；接着发生'] }, phrase: ['succeed in doing 成功做成', 'succeed to 继承'] },
    suggest: { phonetic: '/səˈdʒest/', property: ['v.'], explain: { 'v.': ['建议；提议', '暗示；表明'] }, phrase: ['suggest doing 建议做某事', 'It is suggested that 据建议'] },
    focus: { phonetic: '/ˈfəʊkəs/', property: ['n.', 'v.'], explain: { 'n.': ['焦点；中心', '关注'], 'v.': ['集中；聚焦'] }, phrase: ['focus on 专注于', 'the focus of …的焦点'] },
    master: { phonetic: '/ˈmɑːstə(r)/', property: ['n.', 'v.'], explain: { 'n.': ['主人；大师；硕士'], 'v.': ['掌握；精通'] }, phrase: ['master of 精通…的人', 'master a skill 掌握一项技能'] }
  };

  /* ---------------- 高频动词常考短语库（命中即优先展示） ---------------- */
  const PHRASE_LIB = {
    make: ['make up 组成；编造；化妆', 'make sure 确保', 'make sense 讲得通', 'make a decision 做决定', 'make progress 取得进步'],
    take: ['take part in 参加', 'take care of 照顾', 'take advantage of 利用', 'take place 发生', 'take up 占据；开始从事'],
    get: ['get along with 与…相处', 'get rid of 摆脱', 'get used to 习惯于', 'get over 克服；恢复', 'get through 通过；完成'],
    give: ['give up 放弃', 'give in 屈服', 'give out 分发；耗尽', 'give away 赠送；泄露', 'give off 发出（光/气味）'],
    put: ['put off 推迟', 'put up with 忍受', 'put forward 提出', 'put out 扑灭', 'put on 穿上；上演'],
    come: ['come up with 想出', 'come across 偶然遇到', 'come true 实现', 'come out 出版；结果是', 'come to 总计；苏醒'],
    go: ['go on 继续', 'go over 复习；检查', 'go through 经历；浏览', 'go out 熄灭；外出', 'go up 上升'],
    look: ['look forward to 期待', 'look up 查阅', 'look after 照顾', 'look into 调查', 'look down on 看不起'],
    turn: ['turn out 结果是', 'turn up 出现；调高', 'turn down 拒绝；调低', 'turn into 变成', 'turn off 关掉'],
    break: ['break down 出故障；崩溃', 'break out 爆发', 'break up 分手；解散', 'break into 闯入', 'break through 突破'],
    bring: ['bring up 抚养；提出', 'bring about 引起', 'bring out 使显现；出版', 'bring in 引进；赚取'],
    carry: ['carry out 执行；实施', 'carry on 继续', 'carry through 完成'],
    set: ['set up 建立', 'set off 出发；引发', 'set out 出发；着手', 'set aside 留出；搁置'],
    hold: ['hold on 等一下；坚持', 'hold up 耽搁；举起', 'hold back 抑制；阻碍'],
    keep: ['keep up with 跟上', 'keep on 继续', 'keep away from 远离', 'keep in mind 记住'],
    run: ['run out of 用完', 'run into 偶然遇见', 'run away 逃跑', 'run over 碾过；溢出'],
    call: ['call for 要求；需要', 'call off 取消', 'call on 拜访；号召', 'call up 打电话；使想起'],
    work: ['work out 解决；锻炼', 'work on 从事；致力于', 'work as 担任'],
    agree: ['agree with 同意（某人）', 'agree on 就…达成一致', 'agree to 同意（提议）'],
    depend: ['depend on 依赖；取决于'],
    result: ['result in 导致', 'result from 起因于'],
    lead: ['lead to 导致；通向'],
    deal: ['deal with 处理；应对'],
    consist: ['consist of 由…组成'],
    // 名词常见搭配
    attention: ['pay attention to 注意'],
    advantage: ['take advantage of 利用'],
    effect: ['have an effect on 对…有影响'],
    reason: ['the reason for …的原因'],
    way: ['in this way 用这种方式', 'by the way 顺便说一下'],
    time: ['in time 及时', 'on time 准时', 'at times 有时'],
    case: ['in case of 万一', 'in any case 无论如何']
  };

  /* ---------------- 工具 ---------------- */
  /** 清洗单词：去标点、数字、多余空格 */
  function cleanWord(w) {
    return String(w || '').replace(/[^A-Za-z'\- ]/g, '').trim().toLowerCase();
  }

  /* ---------------- 接口熔断 ----------------
   * 免费接口常因跨域 / 限流 / 额度耗尽而失败。
   * 一旦判定不可用就置位熔断，后续请求直接跳过，避免每个单词都白等超时。
   */
  const breaker = { trans: true, phrase: true };
  function tripOpen(name) { breaker[name] = false; }

  /** 中文翻译（MyMemory 免费接口），失败时返回原文 */
  function translateOne(text) {
    if (!text) return Promise.resolve('');
    if (/[\u4e00-\u9fa5]/.test(text)) return Promise.resolve(text); // 已是中文
    if (!breaker.trans) return Promise.resolve(text);                // 已熔断，直接用英文释义
    const url = API_TRANS + '?q=' + encodeURIComponent(text.slice(0, 400)) + '&langpair=en|zh-CN';
    return u.fetchJson(url, 8000).then(res => {
      const t = res && res.responseData && res.responseData.translatedText;
      // 免费额度用尽时会返回警告文案
      if (!t) { return text; }
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(t)) { tripOpen('trans'); return text; }
      return t;
    }).catch(() => { tripOpen('trans'); return text; });
  }

  /** 批量翻译（限制并发，避免触发限流） */
  function translateMany(list) {
    return u.batch(list, 3, translateOne);
  }

  /**
   * 拉取搭配短语
   * @param {String} word
   * @param {Array}  posList 词性列表
   */
  function fetchPhrases(word, posList) {
    const built = PHRASE_LIB[word.toLowerCase()] || [];
    // 该接口无 CORS 头 / 已熔断时，直接用内置短语库，不再空等
    if (!breaker.phrase) return Promise.resolve(built);
    const isVerb = posList.indexOf('v.') >= 0;
    const isNoun = posList.indexOf('n.') >= 0;
    // 动词：取常见后续共现词；名词：取常见修饰形容词
    const rel = isVerb ? 'rel_trg' : (isNoun ? 'rel_jjb' : 'rel_trg');
    const url = API_PHRASE + '?' + rel + '=' + encodeURIComponent(word) + '&max=6&md=0';
    return u.fetchJson(url, 6000).then(list => {
      const out = built.slice();
      (list || []).slice(0, 6).forEach(item => {
        if (!item || !item.word) return;
        if (!/^[a-z]{2,}$/i.test(item.word)) return;
        const p = isVerb ? (word + ' ' + item.word) : (item.word + ' ' + word);
        if (!out.some(x => x.toLowerCase().indexOf(item.word.toLowerCase()) >= 0)) out.push(p);
      });
      return out.slice(0, 10);
    }).catch(() => { tripOpen('phrase'); return built; });
  }

  /* ---------------- 解析词典 API 返回 ---------------- */
  function parseDictApi(word, json) {
    const data = Array.isArray(json) ? json[0] : null;
    if (!data) return null;
    let phonetic = '', audio = '';
    (data.phonetics || []).forEach(p => {
      if (!phonetic && p && p.text) phonetic = p.text;
      if (!audio && p && p.audio) audio = p.audio;   // 真人发音 mp3（TTS 不可用时的兜底）
    });
    if (!phonetic && data.phonetic) phonetic = data.phonetic;

    const property = [];
    const explain = {};
    const examples = [];
    (data.meanings || []).forEach(m => {
      const pos = u.normPos(m.partOfSpeech);
      if (property.indexOf(pos) < 0) property.push(pos);
      const defs = (m.definitions || []).slice(0, 5).map(d => {
        if (d.example && examples.length < 6) examples.push(d.example);
        return d.definition;
      });
      explain[pos] = (explain[pos] || []).concat(defs);
    });
    if (!property.length) return null;
    return { word: word, phonetic: phonetic, audio: audio, property: property, explain: explain, example: examples.slice(0, 4) };
  }

  /* ---------------- 在线接口连通性探测 ---------------- */
  // 探测一次即可，5 分钟内复用结果；断网时批量导入可直接走本地词库，不再逐个等待超时
  let apiState = { ok: null, at: 0 };

  // 探测用单词：必须是词典里肯定收录的高频词，否则会命中 404 被误判成断网
  const PROBE_WORD = 'word';

  /** 单次探测：只要服务器有 HTTP 响应（含 404 未收录）就说明网络可达 */
  function probeOnce() {
    return new Promise(resolve => {
      if (typeof fetch !== 'function') { resolve(false); return; }   // 环境不支持 fetch
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => { ctl && ctl.abort(); resolve(false); }, 6000);
      fetch(API_DICT + PROBE_WORD, ctl ? { signal: ctl.signal } : undefined)
        .then(r => { clearTimeout(timer); resolve(r.status === 200 || r.status === 404); })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  function probe(force) {
    if (apiState.ok !== null && !force && Date.now() - apiState.at < 5 * 60 * 1000) {
      return Promise.resolve(apiState.ok);
    }
    apiState.at = Date.now();
    // 抖动很常见，失败后再试一次才判定离线
    return probeOnce()
      .then(ok => ok ? true : probeOnce())
      .then(ok => { apiState.ok = ok; return ok; });
  }

  /** 重置探测结果（网络诊断、手动重试时使用） */
  function resetProbe() { apiState.ok = null; apiState.at = 0; }

  /* ---------------- 本地词典服务代理（server.js 提供） ----------------
   * 浏览器直连有道会被 CORS 拦截，境外 API 又未必可达。
   * server.js 在服务端代查（无跨域限制），前端只请求同源的 api/dict。
   * 只要页面是通过 server.js 打开的，在线词典就一定能查到。
   */
  let proxyState = { ok: null, at: 0 };

  /** 相对接口地址转绝对地址（jsdom / 特殊环境下 fetch 相对 URL 会报解析失败） */
  function apiUrl(p) {
    try { return new URL(p, location.href).toString(); } catch (e) { return p; }
  }

  function proxyFetch(url, timeout) {
    return new Promise((resolve, reject) => {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => { ctl && ctl.abort(); reject(new Error('请求超时')); }, timeout || 15000);
      fetch(url, ctl ? { signal: ctl.signal } : undefined)
        .then(r => { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(resolve)
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  /* 是否运行在云端静态托管（GitHub Pages 等公网域名）
   * 这类环境永远不会有 server.js 在同域提供 api/dict，
   * 每个单词都先去探测一次本地服务纯属浪费（还会多等一个 404），直接判定为不可用。 */
  const HOST_IS_CLOUD = (function () {
    const h = (typeof location !== 'undefined' && location.hostname) || '';
    if (!h) return false;                                        // file:// 走本地流程
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^192\.168\./.test(h) || /^10\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;       // 172.16.0.0/12
    if (/^169\.254\./.test(h)) return false;                      // 链路本地
    return true;
  })();

  /** 探测本地词典服务是否可用（5 分钟内复用结论） */
  function probeProxy(force) {
    if (HOST_IS_CLOUD) { proxyState.ok = false; return Promise.resolve(false); }
    if (proxyState.ok !== null && !force && Date.now() - proxyState.at < 5 * 60 * 1000) {
      return Promise.resolve(proxyState.ok);
    }
    proxyState.at = Date.now();
    return proxyFetch(apiUrl('api/dict?probe=1'), 4000)
      .then(j => { proxyState.ok = !!(j && j.__proxy); return proxyState.ok; })
      .catch(() => { proxyState.ok = false; return false; });
  }

  /** 走本地服务查询；查不到或出错返回 null，由调用方继续降级 */
  function proxyLookup(key, opt) {
    const settings = SM.store.getSettings();
    return proxyFetch(apiUrl('api/dict?word=' + encodeURIComponent(key)), 20000)
      .then(j => {
        if (!j || j.notfound || !j.property || !j.property.length) return null;
        const parsed = {
          word: key,
          phonetic: j.phonetic || '',
          audio: j.audio || '',
          property: j.property.slice(),
          explain: JSON.parse(JSON.stringify(j.explain || {})),
          phrase: (j.phrase || []).slice(),
          example: (j.example || []).slice(),
          source: 'proxy'
        };
        CACHE[key] = parsed; saveCache();

        // 备用源给的是英文释义时，补一次中文翻译
        const needTr = opt.translate !== undefined ? opt.translate : settings.translate;
        const firstDef = (parsed.explain[parsed.property[0]] || [])[0] || '';
        if (!needTr || !firstDef || /[\u4e00-\u9fa5]/.test(firstDef)) return parsed;

        const jobs = [];
        parsed.property.forEach(pos => (parsed.explain[pos] || []).slice(0, 2).forEach(d => jobs.push(d)));
        return translateMany(jobs.slice(0, 6)).then(res => {
          let i = 0;
          parsed.property.forEach(pos => {
            const defs = parsed.explain[pos] || [];
            for (let k = 0; k < Math.min(2, defs.length); k++) {
              const t = res[i++];
              if (t && t !== defs[k]) defs[k] = defs[k] + '  【' + t + '】';
            }
          });
          CACHE[key] = parsed; saveCache();
          return parsed;
        });
      })
      .catch(() => null);
  }

  /* ---------------- 主查询入口 ---------------- */
  /**
   * 查询单词（含缓存 / 翻译 / 短语）
   * @param {String} word
   * @param {Object} opt {translate:Boolean, phrase:Boolean, force:Boolean}
   * @returns {Promise<Object>} 归一化后的单词数据；失败返回 {word, offline:true}
   */
  function lookup(word, opt) {
    opt = opt || {};
    const key = cleanWord(word);
    if (!key) return Promise.reject(new Error('单词为空'));
    const settings = SM.store.getSettings();

    // 1) 命中缓存且非强制刷新
    if (!opt.force && CACHE[key]) return Promise.resolve(Object.assign({}, CACHE[key]));

    // 本地兜底结果（在线失败时使用）
    const fallback = localLookup(key) || { word: key, offline: true, property: ['other'], explain: {}, phrase: [] };

    // 2) 未开启联网查询 -> 直接用本地兜底
    if (settings.autoQuery === false || opt.offline) return Promise.resolve(fallback);

    // 3) 优先走本地词典服务（server.js）——不受跨域限制，命中率最高
    return probeProxy(opt.force).then(pok => {
      if (pok) {
        return proxyLookup(key, opt).then(r => r || onlineOrLocal(key, opt, fallback));
      }
      return onlineOrLocal(key, opt, fallback);
    });
  }

  /** 无本地服务时的链路：在线 API -> 本地词库 */
  function onlineOrLocal(key, opt, fallback) {
    // 已经探明在线接口不可达（5 分钟内）-> 直接返回本地结果，避免批量导入时逐个超时等待
    if (apiState.ok === false && !opt.force) return Promise.resolve(fallback);
    // 强制刷新时一并重新探测，否则网络已恢复也会被旧的「离线」结论挡住
    return probe(opt.force).then(ok => {
      if (!ok) return fallback;
      return onlineLookup(key, opt, fallback);
    });
  }

  /**
   * 联网查询主流程（词典 -> 中文翻译 -> 搭配短语）
   * @param {String} key 已清洗的单词
   * @param {Object} opt
   * @param {Object} fallback 失败时的兜底数据
   */
  function onlineLookup(key, opt, fallback) {
    const settings = SM.store.getSettings();
    return u.fetchJson(API_DICT + encodeURIComponent(key), 12000)
      .then(json => parseDictApi(key, json))
      .catch(() => null)
      .then(parsed => {
        if (!parsed) return fallback;   // 接口没查到这个词 -> 回退本地词库
        const needTr = opt.translate !== undefined ? opt.translate : settings.translate;
        const needPh = opt.phrase !== undefined ? opt.phrase : settings.phrase;

        // 收集需要翻译的释义（每个词性最多前 2 条，整体最多 6 条）
        const jobs = [];
        const posList = parsed.property;
        posList.forEach(pos => {
          (parsed.explain[pos] || []).slice(0, 2).forEach(d => jobs.push(d));
        });

        const trPromise = needTr
          ? translateMany(jobs.slice(0, 6)).then(res => {
            // 按顺序回填译文
            let i = 0;
            posList.forEach(pos => {
              const defs = parsed.explain[pos] || [];
              for (let k = 0; k < Math.min(2, defs.length); k++) {
                const t = res[i++];
                // 译文拼在英文后面，便于对照
                if (t && t !== defs[k]) defs[k] = defs[k] + '  【' + t + '】';
              }
            });
          })
          : Promise.resolve();

        const phPromise = needPh ? fetchPhrases(key, posList) : Promise.resolve(PHRASE_LIB[key] || []);

        return Promise.all([trPromise, phPromise]).then(r => {
          parsed.phrase = r[1] || [];
          parsed.source = 'api';
          CACHE[key] = parsed;
          saveCache();
          return Object.assign({}, parsed);
        });
      });
  }

  /** 本地内置词典查询：① 精选词条 ② 离线大词库（window.SM_LOCAL_DICT） */
  function localLookup(word) {
    const key = String(word || '').toLowerCase();

    // ① 精选词条（释义与常考短语更完整，手动维护）
    const d = LOCAL[key];
    if (d) {
      return {
        word: key,
        phonetic: d.phonetic || '',
        property: d.property || ['other'],
        explain: JSON.parse(JSON.stringify(d.explain || {})),
        phrase: (d.phrase || []).slice(),
        example: [],
        source: 'local'
      };
    }

    // ② 离线大词库：{ word: { p:音标, t:{词性:[释义]}, ph:[短语] } }
    const big = (window.SM_LOCAL_DICT || {})[key];
    if (big) {
      const t = big.t || {};
      const property = Object.keys(t).map(u.normPos);
      const explain = {};
      Object.keys(t).forEach(pos => { explain[u.normPos(pos)] = (t[pos] || []).slice(); });
      return {
        word: key,
        phonetic: big.p || '',
        property: property.length ? property : ['other'],
        explain: explain,
        phrase: (big.ph || []).slice(),
        example: [],
        source: 'local'
      };
    }

    // ③ 形态还原：查不到原型时，尝试还原复数 / 时态 / 派生形式
    //    例：abandoned / abandoning -> abandon，studies -> study，running -> run
    const stems = stemCandidates(key);
    for (let i = 0; i < stems.length; i++) {
      const hit = lookupStem(stems[i]);
      if (hit) {
        hit.word = key;                    // 保留用户输入的词形
        hit.source = 'local-stem';         // 标记来自词形还原
        return hit;
      }
    }
    return null;
  }

  /** 按词形枚举可能的原型（只做规则变化，够覆盖常见情况） */
  function stemCandidates(key) {
    const out = [];
    const push = w => { if (w && w.length >= 3 && w !== key && out.indexOf(w) < 0) out.push(w); };
    const C = 'bcdfghjklmnpqrstvwxz';
    // 双写辅音还原：running -> run，stopped -> stop
    if (new RegExp('([' + C + '])\\\\1(ed|ing|er|est)$').test(key)) {
      push(key.replace(new RegExp('([' + C + '])\\\\1(ed|ing|er|est)$'), '$1'));
    }
    if (/ies$/.test(key)) push(key.slice(0, -3) + 'y');
    if (/ied$/.test(key)) push(key.slice(0, -3) + 'y');
    if (/(ches|shes|xes|sses|zes|oes)$/.test(key)) push(key.slice(0, -2));
    if (/ing$/.test(key)) { push(key.slice(0, -3)); push(key.slice(0, -3) + 'e'); }
    if (/ed$/.test(key)) { push(key.slice(0, -2)); push(key.slice(0, -1)); }
    if (/ly$/.test(key)) { push(key.slice(0, -2)); }
    if (/est$/.test(key)) { push(key.slice(0, -3)); push(key.slice(0, -2)); }
    if (/ers?$/.test(key)) { push(key.slice(0, -2)); push(key.slice(0, -1)); }
    if (/s$/.test(key)) push(key.slice(0, -1));
    return out;
  }

  /** 查某个原型（精选词条 + 离线大词库） */
  function lookupStem(k) {
    const d = LOCAL[k];
    if (d) {
      return {
        word: k, phonetic: d.phonetic || '', property: d.property || ['other'],
        explain: JSON.parse(JSON.stringify(d.explain || {})), phrase: (d.phrase || []).slice(),
        example: [], source: 'local'
      };
    }
    const big = (window.SM_LOCAL_DICT || {})[k];
    if (!big) return null;
    const t = big.t || {};
    const property = Object.keys(t).map(u.normPos);
    const explain = {};
    Object.keys(t).forEach(pos => { explain[u.normPos(pos)] = (t[pos] || []).slice(); });
    return {
      word: k, phonetic: big.p || '',
      property: property.length ? property : ['other'],
      explain: explain, phrase: (big.ph || []).slice(), example: [], source: 'local'
    };
  }

  /** 离线词库规模 */
  function localCount() {
    return Object.keys(window.SM_LOCAL_DICT || {}).length + Object.keys(LOCAL).length;
  }

  /**
   * 网络诊断：逐个探测各数据源是否可用，返回 [{name, ok, msg}]
   * 用于「设置 -> 网络诊断」，帮助用户定位是网络问题还是接口问题
   */
  function diagnose() {
    resetProbe();       // 诊断时重新探测，不用缓存结论
    proxyState.ok = null;   // 代理状态也重新探测
    const abs = p => { try { return new URL(p, location.href).toString(); } catch (e) { return p; } };
    const tests = [
      { name: '本地词典服务（server.js 代理，推荐）', url: abs('api/dict?probe=1'), type: 'json' },
      { name: '在线词典（音标 / 多词性 / 释义）', url: API_DICT + PROBE_WORD, type: 'json', allow404: true },
      { name: '中文翻译服务（释义转中文）', url: API_TRANS + '?q=hello&langpair=en|zh-CN', type: 'json' },
      { name: '搭配短语服务', url: API_PHRASE + '?rel_trg=hello&max=3&md=0', type: 'json' },
      { name: 'OCR 引擎（项目本地自带）', url: abs('assets/vendor/tesseract/tesseract.min.js'), type: 'text' },
      { name: 'OCR 语言包（项目本地自带）', url: abs('assets/vendor/tesseract/eng.traineddata.gz'), type: 'text', head: true }
    ];
    return Promise.all(tests.map(t => {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), 8000);
      return fetch(t.url, Object.assign({ method: t.head ? 'HEAD' : 'GET' }, ctl ? { signal: ctl.signal } : {}))
        .then(r => {
          clearTimeout(timer);
          // 词典接口对未收录词返回 404，属于「接口可达」，不算故障
          if (!r.ok && !(t.allow404 && r.status === 404)) throw new Error('HTTP ' + r.status);
          if (t.head) return '';
          return t.type === 'json' ? r.json() : r.text();
        })
        .then(() => ({ name: t.name, ok: true, msg: '可用' }))
        .catch(e => ({ name: t.name, ok: false, msg: (e && e.name === 'AbortError') ? '超时' : (e && e.message) || '不可达' }));
    }));
  }

  /**
   * 批量查询（带进度回调）
   * @param {Array<String>} words
   * @param {Function} onProgress (done,total)
   */
  function lookupMany(words, onProgress) {
    const uniq = [];
    words.forEach(w => { const k = cleanWord(w); if (k && uniq.indexOf(k) < 0) uniq.push(k); });
    return u.batch(uniq, 4, w => lookup(w).catch(() => ({ word: w, offline: true, property: ['other'], explain: {}, phrase: [] })), onProgress);
  }

  SM.dict = {
    lookup, lookupMany, localLookup, cleanWord, localCount,
    translateOne, fetchPhrases, diagnose, probe, resetProbe,
    probeProxy, proxyLookup,
    cacheCount, clearCache,
    PHRASE_LIB, LOCAL
  };
})(window.SM);
