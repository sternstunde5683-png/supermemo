/* ==========================================================================
 * deploy-github.cjs —— 把「超级记忆」整套搬到 GitHub 云端
 *
 * 一条命令完成：
 *   1) 校验令牌、拿到用户名
 *   2) 创建 / 复用 supermemo 仓库，并把站点文件全部提交推送
 *   3) 开启 GitHub Pages（拿到永久 https 网址）
 *   4) 创建一个私有 Gist 当作「云同步空间」
 *   5) 打印网址 + 一键配对链接（手机点开即完成同步配置）
 *
 * 用法：
 *   node deploy-github.cjs <你的 GitHub 令牌>
 *   不带参数运行时会提示输入。
 *
 * 令牌需要两个权限：repo（推送代码）、gist（读写云同步数据）
 * 生成位置：github.com → Settings → Developer settings → Personal access tokens
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'supermemo';
const GIST_FILE = 'supermemo-data.json';

/* ---------------- 颜色输出 ---------------- */
const C = {
  g: s => '\x1b[32m' + s + '\x1b[0m',
  y: s => '\x1b[33m' + s + '\x1b[0m',
  r: s => '\x1b[31m' + s + '\x1b[0m',
  c: s => '\x1b[36m' + s + '\x1b[0m',
  b: s => '\x1b[1m' + s + '\x1b[0m'
};
function say(t) { process.stdout.write(t + '\n'); }

/* ---------------- GitHub API ---------------- */
let TOKEN = '';

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method: method,
      headers: Object.assign({
        'User-Agent': 'supermemo-deploy',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + TOKEN
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (e) { }
        if (res.statusCode >= 400) {
          const msg = (json && json.message) || buf.slice(0, 200);
          const err = new Error('GitHub ' + res.statusCode + '：' + msg);
          err.status = res.statusCode;
          err.body = json;
          reject(err);
          return;
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 令牌是不是「细粒度 PAT」（fine-grained）
 * 判断依据：classic 令牌的请求头里一定有 X-OAuth-Scopes，细粒度令牌没有。
 * 这直接决定后面给什么样的补救指引 —— 两种令牌的授权界面完全不一样。
 */
function tokenKind() {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.github.com', path: '/user', method: 'GET',
      headers: {
        'User-Agent': 'supermemo-deploy',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + TOKEN
      }
    }, r => {
      r.resume();
      r.on('end', () => resolve({
        classic: !!r.headers['x-oauth-scopes'],
        scopes: String(r.headers['x-oauth-scopes'] || '')
      }));
    });
    req.on('error', () => resolve({ classic: false, scopes: '' }));
    req.end();
  });
}

/** 打印「令牌不够用」的统一指引 */
function printTokenHelp(kind) {
  say(C.r('  × 这个令牌的权限不够，GitHub 拒绝了操作'));
  say('');
  if (kind && kind.classic) {
    say(C.y('  你现在用的是 classic（经典）令牌，请在令牌页勾选这两项：'));
    say('    ☑ repo   （建仓库、推代码）');
    say('    ☑ gist   （存私有同步数据）');
  } else {
    say(C.y('  你现在用的是 fine-grained（细粒度）令牌 —— 它默认是「零权限」的，'));
    say(C.y('  新建时如果没逐项勾 CAS 会全部失败。两条路任选其一：'));
    say('');
    say(C.b('  【推荐 · 最省事】改用 classic 令牌'));
    say('    1) 打开 https://github.com/settings/tokens');
    say('    2) Generate new token (classic)');
    say('    3) 勾选 repo + gist，其它都不用管，有效期选 No expiration');
    say('    4) 生成后复制整串，回来重新运行本程序');
    say('');
    say(C.b('  【备选 · 最小权限】继续用细粒度令牌，但要补齐这些开关'));
    say('    · Repository access 选 All repositories（或先手工建好 supermemo 仓库后选它）');
    say('    · Repository permissions:');
    say('        Contents            Read and write   推代码用');
    say('        Pages               Read and write   开启 Pages 用');
    say('        Administration      Read and write   创建仓库用');
    say('    · Account permissions:');
    say('        Gists               Read and write   存云端词库用');
  }
  say('');
  say(C.y('  提示：随便换一台新设备都不用重做，令牌只在第一次部署时需要。'));
}

/**
 * 权限自检
 * 与其让用户推了一半才发现失败，不如开局就探一遍。
 * 只做「能完整清理」的探测（临时 Gist 建完即删），不在用户账号里留垃圾。
 */
async function preflight() {
  const kind = await tokenKind();

  // ① Gist 写权限（不同步数据的话整个云同步就是摆设）
  let gistWrite = false;
  try {
    const g = await api('POST', '/gists', {
      description: 'supermemo · 权限探测（会自动删除）',
      public: false,
      files: { 'probe.txt': { content: 'ok' } }
    });
    gistWrite = true;
    if (g && g.id) { try { await api('DELETE', '/gists/' + g.id); } catch (e) { } }
  } catch (e) {
    gistWrite = false;
  }

  if (!gistWrite) {
    printTokenHelp(kind);
    return false;
  }
  say(C.g('  ✓ 令牌权限检查通过（可读写私有云空间）'));
  return true;
}

/* ---------------- 本地 git ---------------- */
function git(args, opts) {
  opts = opts || {};
  const r = spawnSync('git', args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GIT_AUTHOR_NAME: 'supermemo',
      GIT_AUTHOR_EMAIL: 'supermemo@local',
      GIT_COMMITTER_NAME: 'supermemo',
      GIT_COMMITTER_EMAIL: 'supermemo@local'
    })
  });
  if (r.error) throw r.error;
  if (opts.allowFail) return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
  if (r.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' 失败\n' + (r.stdout || '') + (r.stderr || ''));
  }
  return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
}

/** 不该上传的东西 */
function writeGitignore() {
  const p = path.join(ROOT, '.gitignore');
  const lines = [
    '# 本地运行环境与日志',
    '.workbuddy/',
    'node_modules/',
    '*.log',
    'sm-guard.log',
    '',
    '# 本地局域网同步的数据（含个人生词，绝不外传）',
    'data/',
    '',
    '# 临时构建产物',
    '_dist/',
    '_*.html',
    '_*.png',
    '_*.txt',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# 本机 Windows 启动脚本（内含本机文件路径，且云端用不上，不外传）',
    '*.vbs',
    '*.bat',
    'sm-*.cmd'
  ];
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8').indexOf('data/') < 0) {
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    say(C.y('  · 已写入 .gitignore（本地数据与日志不会上传）'));
  }
  return p;
}

/** 提交当前全部站点文件 */
function commitAll() {
  writeGitignore();
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    say(C.y('  · 初始化本地 Git 仓库'));
    git(['init']);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(['add', '-A']);
  const st = git(['status', '--porcelain'], { allowFail: true });
  if (st.ok && !String(st.out).trim()) {
    say(C.y('  · 文件没有变化，跳过提交'));
    return false;
  }
  git(['commit', '-m', '超级记忆 · 云端部署 ' + new Date().toLocaleString()]);
  say(C.g('  ✓ 已打包 ' + countFiles() + ' 个文件'));
  return true;
}

function countFiles() {
  const r = git(['ls-files'], { allowFail: true });
  return r.ok ? String(r.out).trim().split('\n').filter(Boolean).length : '若干';
}

/* ---------------- 上传方式：Git Data API ----------------
 * 为什么不用 git push：
 *   站点里带 OCR 引擎（eng.traineddata.gz 约 11MB），整包近 19MB 一次性 POST，
 *   国内网络经常中途被重置 —— curl 55 Send failure / remote end hung up。
 *   改成「一个文件一次请求」后单个包小得多，失败还能单独重试某一个文件，成功率明显更高。
 * 流程：逐个建 blob → 合成一棵 tree → 生成一个 commit → 把 main 指过去。
 */
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function listFiles() {
  const out = git(['ls-files', '-z'], { allowFail: true }).out || '';
  return String(out).split('\0').filter(Boolean);
}

/** 取 main 分支的最新提交；空仓库返回 { parent: null, baseTree: null } */
async function getHead(owner) {
  try {
    const ref = await api('GET', '/repos/' + owner + '/' + REPO_NAME + '/git/ref/heads/main');
    const c = await api('GET', '/repos/' + owner + '/' + REPO_NAME + '/git/commits/' + ref.object.sha);
    return { parent: ref.object.sha, baseTree: c.tree.sha };
  } catch (e) {
    return { parent: null, baseTree: null };
  }
}

async function uploadViaApi(owner) {
  const branch = 'main';
  const files = listFiles();
  if (!files.length) throw new Error('没有可上传的文件');

  let head = await getHead(owner);

  // 全新仓库连 blob 都建不了（409 Git Repository is empty），
  // 先用 Contents 接口落一个 README，把 main 分支creation出来。
  if (!head.parent) {
    say(C.y('  · 空仓库初始化中…'));
    await api('PUT', '/repos/' + owner + '/' + REPO_NAME + '/contents/README.md', {
      message: '初始化仓库',
      content: Buffer.from('# 超级记忆\n', 'utf8').toString('base64'),
      branch: branch
    });
    head = await getHead(owner);
  }

  const tree = [];
  let done = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const size = fs.statSync(abs).size;
    const mb = (size / 1048576).toFixed(1);

    let sha = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const b = await api('POST', '/repos/' + owner + '/' + REPO_NAME + '/git/blobs', {
          content: fs.readFileSync(abs).toString('base64'),
          encoding: 'base64'
        });
        sha = b.sha;
        break;
      } catch (e) {
        if (attempt === 4) throw new Error('上传 ' + rel + ' 失败：' + e.message);
        say(C.y('    ! ' + rel + ' 第 ' + attempt + ' 次失败，正在重试…'));
        await delay(1500 * attempt);
      }
    }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: sha });
    done++;
    say('    (' + done + '/' + files.length + ') ' + rel + '  ' + mb + 'MB');
  }

  const t = await api('POST', '/repos/' + owner + '/' + REPO_NAME + '/git/trees', {
    base_tree: head.baseTree,
    tree: tree
  });
  const c = await api('POST', '/repos/' + owner + '/' + REPO_NAME + '/git/commits', {
    message: '超级记忆 · 云端部署 ' + new Date().toLocaleString(),
    tree: t.sha,
    parents: head.parent ? [head.parent] : []
  });

  await api('PATCH', '/repos/' + owner + '/' + REPO_NAME + '/git/refs/heads/' + branch,
    { sha: c.sha, force: true });
  return files.length;
}

/* ---------------- 主流程 ---------------- */
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

(async function main() {
  say('');
  say(C.b('  超级记忆 · 一键上云'));
  say('  --------------------------------------------');

  TOKEN = (process.argv[2] || '').trim();
  if (!TOKEN) {
    TOKEN = (await ask('  请粘贴 GitHub 令牌：') || '').trim();
  }
  if (!TOKEN) { say(C.r('  × 没有提供令牌，已取消')); process.exit(1); }

  /* 1) 校验令牌 & 取用户名 */
  let me;
  try {
    me = await api('GET', '/user');
  } catch (e) {
    say(C.r('  × 令牌无效或网络不通：' + e.message));
    say(C.y('    提示：令牌需要勾选 repo 和 gist 两项权限'));
    process.exit(1);
  }
  const owner = me.login;
  say(C.g('  ✓ 已登录 GitHub：' + owner));

  /* 1.5) 权限自检：先确认令牌真的能干活，别推一半才报错 */
  say(C.y('  · 正在检查令牌权限…'));
  if (!(await preflight())) process.exit(1);

  /* 2) 仓库 */
  let repo = null;
  try {
    repo = await api('GET', '/repos/' + owner + '/' + REPO_NAME);
    say(C.g('  ✓ 复用已有仓库：' + repo.full_name));
  } catch (e) {
    if (e.status !== 404) {
      say('');
      await printTokenHelp(await tokenKind());
      say(C.y('  （GitHub 原话：' + e.message + '）'));
      process.exit(1);
    }
    try {
      repo = await api('POST', '/user/repos', {
        name: REPO_NAME,
        description: '超级记忆 · 个人英语生词本（支持手机扫码、OCR 拍照选词、跨设备云同步）',
        private: false,
        auto_init: false
      });
      say(C.g('  ✓ 已创建仓库：' + repo.full_name));
    } catch (e2) {
      say('');
      await printTokenHelp(await tokenKind());
      say(C.y('  （GitHub 原话：' + e2.message + '）'));
      process.exit(1);
    }
  }

  /* 3) 提交并推送 */
  say(C.y('  · 正在打包站点文件（首次会慢一点）…'));
  commitAll();

  // remote 只留个地址方便以后手动 git 操作，绝不含令牌（免得令牌写进 .git/config 留在本机）
  const rem = git(['remote', 'get-url', 'origin'], { allowFail: true });
  const plainUrl = 'https://github.com/' + owner + '/' + REPO_NAME + '.git';
  if (!rem.ok) git(['remote', 'add', 'origin', plainUrl]);
  else git(['remote', 'set-url', 'origin', plainUrl]);

  say(C.y('  · 正在上传站点文件到 GitHub（逐文件上传，失败会自动重试）…'));
  try {
    const n = await uploadViaApi(owner);
    say(C.g('  ✓ 已上传 ' + n + ' 个文件'));
  } catch (e) {
    say(C.r('  × 上传失败：' + e.message));
    say(C.y('    网络抖动很常见，直接重跑本程序即可接着传（已传过的不会重复计费）。'));
    process.exit(1);
  }

  /* 4) 开启 Pages */
  const pageUrl = 'https://' + owner.toLowerCase() + '.github.io/' + REPO_NAME + '/';
  try {
    try {
      await api('POST', '/repos/' + owner + '/' + REPO_NAME + '/pages', { source: { branch: 'main', path: '/' } });
      say(C.g('  ✓ 已开启 GitHub Pages'));
    } catch (e) {
      if (e.status === 409) {                       // 已经开启过了，改一下就算更新
        await api('PUT', '/repos/' + owner + '/' + REPO_NAME + '/pages', { source: { branch: 'main', path: '/' } });
        say(C.g('  ✓ GitHub Pages 已是开启状态'));
      } else throw e;
    }
  } catch (e) {
    say(C.y('  ! Pages 未能自动开启：' + e.message));
    say(C.y('    可以手动操作：仓库 Settings → Pages → Source 选 main 分支 → Save'));
  }

  /* 5) 云同步空间（私有 Gist） */
  let gistId = '';
  try {
    const list = await api('GET', '/gists?per_page=100');
    const found = (list || []).find(g =>
      g.description && g.description.indexOf('超级记忆') >= 0 &&
      g.files && g.files[GIST_FILE]);
    if (found) {
      gistId = found.id;
      say(C.g('  ✓ 复用已有云同步空间：' + gistId));
    } else {
      // ⚠️ 必须一次带上数据文件：GitHub 不允许创建「空的」Gist（files: {} 会返回 422）
      const files = {};
      files[GIST_FILE] = { content: JSON.stringify({ schema: 1, updatedAt: Date.now(), words: [], notes: [], deleted: {} }) };
      const g = await api('POST', '/gists', {
        description: '超级记忆 · 生词本云同步数据',
        public: false,
        files: files
      });
      gistId = g.id;
      say(C.g('  ✓ 已创建私有云同步空间：' + gistId));
    }
  } catch (e) {
    say(C.y('  ! 云同步空间创建失败：' + e.message));
    say(C.y('    同步功能暂时不可用，网站仍可正常访问。'));
  }

  /* 6) 收尾：确认本机没有残留令牌 */

  /* 7) 输出结果 */
  const pairCode = gistId
    ? 'SM1:' + Buffer.from(JSON.stringify({ t: TOKEN, g: gistId, m: 'gist' }), 'utf8').toString('base64')
    : '';

  say('');
  say(C.b('  🎉 全部完成'));
  say('  --------------------------------------------');
  say('  网站地址（永久）：' + C.c(pageUrl));
  say('  把它存成书签，或手机「添加到主屏幕」。');
  say('');
  say(C.y('  首次开启 Pages 需要等 1~2 分钟，出现 404 属正常，稍等再刷新。'));
  say('');

  if (pairCode) {
    say(C.b('  手机 / 其他电脑一键连同步（点开即配好，不要发给别人）：'));
    say('');
    say('    ' + pageUrl + '#sync=' + encodeURIComponent(pairCode));
    say('');
    fs.writeFileSync(path.join(ROOT, '我的同步链接.txt'),
      '超级记忆 · 私人同步链接（千万不要发给别人，里面包含你的 GitHub 令牌）\n\n' +
      '网站地址：' + pageUrl + '\n\n' +
      '一键同步链接：\n' + pageUrl + '#sync=' + encodeURIComponent(pairCode) + '\n\n' +
      '用法：在自己另一台设备的浏览器里打开「一键同步链接」即可自动连上同一份生词本。\n' +
      '如果失效（比如你在 GitHub 删了这个令牌），重新运行 部署到GitHub.bat 会生成新的。\n',
      'utf8');
    say(C.y('  这份链接已同时保存到：我的同步链接.txt'));
    say(C.y('  ⚠️ 里面含令牌，只看你自己，别发到群里。'));
  }
  say('');
})().catch(e => {
  say(C.r('  × 出错了：' + (e.message || e)));
  console.error(e);
  process.exit(1);
});
