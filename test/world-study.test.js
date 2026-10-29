// test/world-study.test.js
// v0.7 学习卡片闭环：稳定 keyword id / 卡片追加幂等 / 考点归属匹配 / 日报回填接入
//
// 这组测试守的是一条真实断链：v0.6.5 里关键词收敛后只写 techstack.json，
// 链路上没有任何 writer，于是"配了关键词却从没生成过学习 md"。
// 下面每一项都对准那条链路上的一环。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { keywordId, keywordIds, loadTechstack, addGoal, cleanKeywords } = require('../world/techstack/config');
const card = require('../world/study/card');
const scanner = require('../world/study/scanner');
const study = require('../world/study');
const { normalizeTechTips } = require('../world/summarizer');

function tmpDir(prefix = 'dwstudy-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const GOALS = [
  {
    id: 'tabc123',
    direction: '后端开发',
    keywords: ['electron主进程 IPC 通信设计', 'shell脚本与CLI自动化批处理', '番茄钟定时器状态机设计'],
    kwIds: {
      'electron主进程 IPC 通信设计': 'kw-aaaa0001',
      'shell脚本与CLI自动化批处理': 'kw-bbbb0002',
      '番茄钟定时器状态机设计': 'kw-cccc0003',
    },
  },
];

// ---------- 稳定 keyword id ----------

test('keywordId：确定性 / 形如 kw-<hash8> / 大小写不敏感 / 中文可用', () => {
  const a = keywordId('electron 主进程 IPC 通信设计');
  assert.match(a, /^kw-[0-9a-f]{8}$/);
  assert.equal(a, keywordId('electron 主进程 IPC 通信设计'), '同词必得同 id（跨天跨进程稳定）');
  assert.equal(a, keywordId('  Electron 主进程 IPC 通信设计  '), '大小写与首尾空白不影响 id');
  assert.equal(keywordId('状态管理'), keywordId('状态管理'));
  assert.notEqual(keywordId('状态管理'), keywordId('web-socket 握手'));
  assert.equal(keywordId(''), null);
  assert.equal(keywordId(null), null);
});

test('keywordId：不同进程（子进程重算）得到同一个 id——文件名不能依赖运行期状态', () => {
  // 用子进程独立 require 一遍，模拟 App 与 CLI 两个不同进程各自算 id
  const { execFileSync } = require('node:child_process');
  const script = `const {keywordId}=require(${JSON.stringify(require.resolve('../world/techstack/config'))});process.stdout.write(keywordId('番茄钟定时器状态机设计'));`;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out, keywordId('番茄钟定时器状态机设计'));
});

test('keywordIds：老配置没有 kwIds 时读时补齐；已有 id 被冻结（换算法不漂移）', () => {
  const built = keywordIds(['状态管理', 'web-socket 握手']);
  assert.equal(Object.keys(built).length, 2);
  assert.match(built['状态管理'], /^kw-[0-9a-f]{8}$/);

  const frozen = keywordIds(['状态管理'], { 状态管理: 'kw-deadbeef' });
  assert.equal(frozen['状态管理'], 'kw-deadbeef', '已存在的 id 原样保留，卡片不搬家');
  // 脏 id 不可信，走算法重算
  assert.notEqual(keywordIds(['状态管理'], { 状态管理: 'evil' })['状态管理'], 'evil');
});

test('config：addGoal 落盘 kwIds；改关键词时保留仍在的旧词 id', () => {
  const file = path.join(tmpDir(), 'techstack.json');
  const r = addGoal({ direction: '后端', keywords: ['状态管理', 'web-socket 握手'] }, file);
  const firstId = r.goal.kwIds['状态管理'];
  assert.match(firstId, /^kw-[0-9a-f]{8}$/);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.goals[0].kwIds['状态管理'], firstId, 'kwIds 真的写进了盘');

  // 改关键词：老词 id 不变，新词拿到自己的 id
  const r2 = addGoal({ direction: '后端', keywords: ['状态管理', '长上下文会话摘要'] }, file);
  assert.equal(r2.goal.kwIds['状态管理'], firstId, '仍在的词 id 冻结');
  assert.ok(r2.goal.kwIds['长上下文会话摘要']);

  // 老配置（无 kwIds）读时不崩，且内存里补齐
  const legacy = path.join(tmpDir(), 'techstack.json');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, goals: [{ id: 'g1', direction: '后端', keywords: ['状态管理'] }] }));
  const g = loadTechstack(legacy).goals[0];
  assert.match(g.kwIds['状态管理'], /^kw-[0-9a-f]{8}$/);
});

// ---------- 卡片渲染与追加（纯函数） ----------

test('renderNewCard：含方向 / 状态 / id / 首次收录 / 空白区', () => {
  const md = card.renderNewCard({
    keyword: '状态管理',
    direction: '后端开发',
    kwId: 'kw-aaaa0001',
    date: '2026-10-07',
    sourceFile: 'tips-2026-10-07.md',
  });
  assert.match(md, /^# 状态管理/);
  assert.match(md, /所属方向：后端开发/);
  assert.match(md, /状态：待补料/);
  assert.match(md, /关键词 id：kw-aaaa0001/);
  assert.match(md, /首次收录：2026-10-07/);
  assert.match(md, /最近命中：尚未命中/, '建档时没有任何实证，不得谎报"今天已命中"');
  assert.match(md, /## 🧩 空白区/);
  assert.match(md, /还没有真实会话命中/);
  assert.equal(card.deriveStatus(md), card.STATUS.pending);
});

test('renderNewCard：日期非法时不谎报"最近命中"，只标尚未命中', () => {
  const md = card.renderNewCard({ keyword: 'k', direction: 'd', kwId: 'kw-00000000', date: '', sourceFile: '' });
  assert.match(md, /最近命中：尚未命中/);
  assert.match(md, /首次收录：（未记录）/);
});

test('appendEvidence：结构化考点按行段排版，追加而非覆盖', () => {
  const base = card.renderNewCard({ keyword: 'IPC', direction: '后端', kwId: 'kw-1', date: '2026-10-06', sourceFile: 'x.md' });
  const next = card.appendEvidence(base, {
    date: '2026-10-07',
    sourceFile: 'tips-2026-10-07.md',
    tips: [{ topic: 'electron 主进程 IPC 通信设计', project: 'desktop-world', answer: '主进程持有状态。', hook: '渲染层无特权。', action: '把写盘收进主进程' }],
  });
  assert.ok(next, '应产出新正文');
  assert.match(next, /## 📌 今日实证（2026-10-07）/);
  assert.match(next, /【考点】electron 主进程 IPC 通信设计/);
  assert.match(next, /\*\*标准答案\*\*：主进程持有状态。/);
  assert.match(next, /\*\*记忆钩子\*\*：渲染层无特权。/);
  assert.match(next, /\*\*可操作方法\*\*：把写盘收进主进程/);
  assert.match(next, /状态：学习中/, '有实证后状态从待补料变学习中');
  assert.match(next, /最近命中：2026-10-07（来自 tips-2026-10-07\.md）/);
  assert.doesNotMatch(next, /## 🧩 空白区/, '一旦有实证，空白区让位');
  assert.match(next, /首次收录：2026-10-06/, '首次收录时间不被动');
});

test('appendEvidence：同日幂等——同一天再追加返回 null，正文一个字都不变', () => {
  const base = card.renderNewCard({ keyword: 'IPC', direction: '后端', kwId: 'kw-1', date: '2026-10-06', sourceFile: 'x.md' });
  const opts = { date: '2026-10-07', sourceFile: 'tips-2026-10-07.md', tips: [{ topic: 'IPC 设计', answer: 'a' }] };
  const once = card.appendEvidence(base, opts);
  const twice = card.appendEvidence(once, opts);
  assert.equal(twice, null, '第二次必须拒绝');
  assert.equal(card.appendEvidence(once, { ...opts, tips: [{ topic: '另一条' }] }), null, '同天换内容也拒绝');
});

test('appendEvidence：不同天可以连续追加，≥3 天判为已沉淀', () => {
  let body = card.renderNewCard({ keyword: 'IPC', direction: '后端', kwId: 'kw-1', date: '2026-10-01', sourceFile: 'x.md' });
  // 建档日不算实证日：状态推进只看真正追加进来的分节
  assert.equal(card.deriveStatus(body), card.STATUS.pending);
  for (const d of ['2026-10-02', '2026-10-03']) {
    const next = card.appendEvidence(body, { date: d, sourceFile: `tips-${d}.md`, tips: [{ topic: `IPC 第 ${d} 条` }] });
    assert.ok(next, `${d} 应追加成功`);
    body = next;
  }
  assert.equal(card.countEvidenceDays(body).size, 2);
  assert.equal(card.deriveStatus(body), card.STATUS.learning, '2 天还在攒');
  body = card.appendEvidence(body, { date: '2026-10-04', sourceFile: 'tips-2026-10-04.md', tips: [{ topic: 'IPC 第 2026-10-04 条' }] });
  assert.equal(card.deriveStatus(body), card.STATUS.settled, '满 3 天判为已沉淀');
  // 历史三条都在，没有被后一天覆盖
  assert.match(body, /IPC 第 2026-10-02 条/);
  assert.match(body, /IPC 第 2026-10-03 条/);
  assert.match(body, /IPC 第 2026-10-04 条/);
});

test('appendEvidence：空 tips / 垃圾 tip / 非法日期都不产出正文', () => {
  const base = card.renderNewCard({ keyword: 'IPC', direction: '后端', kwId: 'kw-1', date: '2026-10-06', sourceFile: 'x.md' });
  assert.equal(card.appendEvidence(base, { date: '2026-10-07', tips: [] }), null);
  assert.equal(card.appendEvidence(base, { date: '2026-10-07', tips: [null, 42, { noTopic: 1 }] }), null);
  assert.equal(card.appendEvidence(base, { date: '不是日期', tips: [{ topic: 'x' }] }), null);
  assert.equal(card.appendEvidence(base, { date: '', tips: [{ topic: 'x' }] }), null);
  assert.equal(card.appendEvidence('', { date: '2026-10-07', tips: [{ topic: 'x' }] }), null, '空正文应先建档再追加');
});

test('appendEvidence：用户输入里的换行不能伪造出新的分节', () => {
  const base = card.renderNewCard({ keyword: 'IPC', direction: '后端', kwId: 'kw-1', date: '2026-10-06', sourceFile: 'x.md' });
  const next = card.appendEvidence(base, {
    date: '2026-10-07',
    tips: [{ topic: '第一行\n## 伪造分节', answer: '答案\r\n第二行' }],
  });
  assert.ok(next);
  // 真正的不变量：全文只有一个 "## " 开头且是我们自己写的那两个分节
  const headings = next.split('\n').filter((l) => l.startsWith('## '));
  assert.equal(headings.length, 1, `只应有一个分节，实际：${JSON.stringify(headings)}`);
  assert.match(headings[0], /^## 📌 今日实证（2026-10-07）/);
  assert.match(next, /第一行 ## 伪造分节/, '换行被折成空格而不是拆出新分节');
  assert.ok(!next.includes('## 🧩 空白区'), '空白区不因伪造输入而复活');
  // 表格竖线收掉，避免破坏 index 之外的表格渲染
  const pipe = card.appendEvidence(base, { date: '2026-10-08', tips: [{ topic: 'a | b | c' }] });
  assert.ok(!pipe.includes('| b |'), '竖线被收成 /');
});

// ---------- 考点归属匹配 ----------

test('scanner.normalizeTip：只收结构化考点对象，旧字符串返回 null（宁缺毋滥）', () => {
  assert.equal(scanner.normalizeTip('普通字符串 tip'), null);
  assert.equal(scanner.normalizeTip(null), null);
  assert.equal(scanner.normalizeTip({ noTopic: 1 }), null);
  const t = scanner.normalizeTip({ topic: ' IPC 设计 ', project: ' dw ', answer: ' a ', hook: '', action: 'x' });
  assert.deepEqual(t, { topic: 'IPC 设计', project: 'dw', answer: 'a', hook: '', action: 'x' });
});

test('scanner.tipMatchesKeyword：强匹配命中 / 无关考点不认亲', () => {
  const tip = scanner.normalizeTip({ topic: 'electron 主进程 IPC 通信设计', project: 'desktop-world', answer: '主进程持有状态' });
  assert.equal(scanner.tipMatchesKeyword('electron主进程 IPC 通信设计', tip), true, '整词包含');
  assert.equal(scanner.tipMatchesKeyword('IPC 通信设计', tip), true, '关键词是标题的显著子串');
  assert.equal(scanner.tipMatchesKeyword('electron主进程 IPC 通信设计', scanner.normalizeTip({ topic: 'zustand persist 持久化' })), false);
  assert.equal(scanner.tipMatchesKeyword('', tip), false);
  assert.equal(scanner.tipMatchesKeyword('IPC', null), false);
});

test('scanner：短通用词不做弱匹配，避免"ipc""状态"这类词乱认亲', () => {
  const tip = scanner.normalizeTip({ topic: 'electron 主进程通信', answer: '这里提到了 ipc 两个字母' });
  assert.equal(scanner.tipMatchesKeyword('ipc', tip), false, '答案里的短词不算证据');
  assert.equal(scanner.tipMatchesKeyword('ipc', scanner.normalizeTip({ topic: 'ipc 通信' })), true, '标题里出现可以');
});

test('scanner.compact：归一化去掉所有空白——空格之差不能导致漏匹配', () => {
  // 真实缺陷（首日端到端冒烟实测到）：模型输出带空格、配置关键词不带，
  // 直接做子串包含会因一个空格之差整个失配，表现为"配了关键词但卡片永远空白"。
  assert.equal(scanner.compact('electron 主进程 IPC 通信设计'), 'electron主进程ipc通信设计');
  assert.equal(scanner.compact('  A\tB\nC '), 'abc');
  assert.equal(scanner.compact(null), '');
  const tip = scanner.normalizeTip({ topic: 'electron 主进程 IPC 通信设计' });
  assert.equal(scanner.tipMatchesKeyword('electron主进程IPC通信设计', tip), true, '带空格/不带空格要能对上');
  assert.equal(scanner.tipMatchesKeyword('electron  主进程   IPC 通信设计', tip), true, '多个空格也要能对上');
  assert.equal(scanner.tipMatchesKeyword('ELECTRON 主进程 IPC 通信设计', tip), true, '大小写不敏感');
  // 弱匹配路径同样走归一化：项目名里带空格也要能对上长关键词
  assert.equal(
    scanner.tipMatchesKeyword(
      'electron主进程IPC通信设计',
      scanner.normalizeTip({ topic: '今天做了 IPC 改造', project: 'desktop-world  electron 主进程 IPC 通信设计 专项' }),
    ),
    true,
    '项目名里的长关键词（带空格）要被认出来',
  );
  // 但答案里"提到"一个断成两截的词不算——候选串必须完整出现
  assert.equal(
    scanner.tipMatchesKeyword('主进程通信', scanner.normalizeTip({ topic: '别的考点', answer: '讲的是 electron 主进程 IPC 通信设计' })),
    false,
    '候选串被拆开就不算命中（宁缺毋滥）',
  );
});

test('scanner.matchReport：按关键词分组，一个考点可归属多个相关关键词', () => {
  const report = {
    meta: { date: '2026-10-07' },
    techTips: [
      { topic: 'electron 主进程 IPC 通信设计', answer: 'x' },
      { topic: '完全无关的论文排版', answer: 'y' },
    ],
  };
  const m = scanner.matchReport(report, GOALS);
  assert.equal(m.date, '2026-10-07');
  const kws = m.matched.map((x) => x.keyword);
  assert.ok(kws.includes('electron主进程 IPC 通信设计'));
  assert.ok(!kws.includes('完全无关的论文排版'.slice(0, 3)) || kws.length === 1);
  assert.equal(m.matched.length, 1, '只有 1 个关键词真的命中');
  assert.equal(m.matched[0].kwId, 'kw-aaaa0001', '带上稳定 id');
});

test('scanner.matchReport：无目标 / 无日期 / 旧字符串 tips 都安全返回', () => {
  assert.deepEqual(scanner.matchReport({ meta: { date: '2026-10-07' }, techTips: [{ topic: 'x' }] }, []).matched, []);
  assert.deepEqual(scanner.matchReport({ techTips: [{ topic: 'x' }] }, GOALS).matched, [], '没日期不处理');
  const legacy = scanner.matchReport({ meta: { date: '2026-10-07' }, techTips: ['旧字符串 tip'] }, GOALS);
  assert.deepEqual(legacy.matched, [], '旧字符串无法可靠归属，不硬凑');
});

// ---------- IO 层：追加 / 建档 / index ----------

test('study.appendDay：回填到对应卡片，且同日重跑幂等', () => {
  const root = tmpDir();
  const tips = [{ topic: 'electron 主进程 IPC 通信设计', answer: '主进程持有状态。', hook: 'h', action: 'a' }];
  const r1 = study.appendDay(GOALS, { date: '2026-10-07', tips, sourceFile: 'tips-2026-10-07.md', root });
  assert.equal(r1.written.length, 1, '只有命中的那张卡被写');
  assert.ok(r1.written[0].endsWith('kw-aaaa0001.md'), '文件名是稳定 id，不是中文标题');

  const before = fs.readFileSync(r1.written[0], 'utf8');
  const r2 = study.appendDay(GOALS, { date: '2026-10-07', tips, sourceFile: 'tips-2026-10-07.md', root });
  assert.equal(r2.written.length, 0);
  assert.equal(r2.skipped.length, 1);
  assert.equal(fs.readFileSync(r1.written[0], 'utf8'), before, '文件内容逐字不变');
});

test('study.appendDay：跨天累积，历史不被覆盖', () => {
  const root = tmpDir();
  study.appendDay(GOALS, { date: '2026-10-06', tips: [{ topic: 'IPC 通信设计第一版' }], root });
  study.appendDay(GOALS, { date: '2026-10-07', tips: [{ topic: 'IPC 通信设计第二版' }], root });
  const body = fs.readFileSync(path.join(root, GOALS[0].id, 'kw-aaaa0001.md'), 'utf8');
  assert.match(body, /IPC 通信设计第一版/);
  assert.match(body, /IPC 通信设计第二版/);
});

test('study.ensureCards：没材料也要建档写空白区（修"配了关键词却什么都没看到"）', () => {
  const root = tmpDir();
  const r = study.ensureCards(GOALS, { date: '2026-10-07', root });
  assert.equal(r.created.length, 3, '3 个关键词各建一张');
  const body = fs.readFileSync(path.join(root, GOALS[0].id, 'kw-cccc0003.md'), 'utf8');
  assert.match(body, /## 🧩 空白区/);
  assert.match(body, /还没有真实会话命中/);
  assert.equal((fs.statSync(path.join(root, GOALS[0].id, 'kw-cccc0003.md')).mode & 0o777), 0o600, '落盘 0600');

  // 再跑一次不重复建
  const again = study.ensureCards(GOALS, { date: '2026-10-07', root });
  assert.equal(again.created.length, 0);
  assert.equal(again.existed.length, 3);
});

test('study.cardPath：用稳定 id，目录名不含中文（跨平台安全）', () => {
  const p = study.cardPath('/tmp/x', GOALS[0], '番茄钟定时器状态机设计');
  assert.equal(p, path.join('/tmp/x', 'tabc123', 'kw-cccc0003.md'));
  assert.ok(!/[一-鿿]/.test(p), '路径不含中文');
});

test('study.listCards：状态 / 天数 / 最近命中都能读出来', () => {
  const root = tmpDir();
  study.ensureCards(GOALS, { date: '2026-10-01', root });
  study.appendDay(GOALS, { date: '2026-10-02', tips: [{ topic: 'IPC 通信设计 A' }], root });
  const cards = study.listCards({ root, goals: GOALS });
  assert.equal(cards.length, 3);
  const ipc = cards.find((c) => c.kwId === 'kw-aaaa0001');
  assert.equal(ipc.dayCount, 1);
  assert.equal(ipc.lastHit, '2026-10-02');
  assert.equal(ipc.status, card.STATUS.learning);
  const pomo = cards.find((c) => c.kwId === 'kw-cccc0003');
  assert.equal(pomo.dayCount, 0);
  assert.equal(pomo.status, card.STATUS.pending);
  assert.equal(pomo.exists, true, '空白区也算已建档');
});

test('study.writeIndex：总览列出全部目标 × 关键词 × 进度', () => {
  const root = tmpDir();
  study.ensureCards(GOALS, { date: '2026-10-01', root });
  study.appendDay(GOALS, { date: '2026-10-02', tips: [{ topic: 'IPC 通信设计 A' }], root });
  const { file, count } = study.writeIndex({ root, goals: GOALS });
  assert.equal(count, 3);
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /# 学习卡片总览/);
  assert.match(md, /## 🎯 后端开发/);
  assert.match(md, /electron主进程 IPC 通信设计/);
  assert.match(md, /番茄钟定时器状态机设计/);
  assert.match(md, /学习中/);
  assert.match(md, /待补料/);
  assert.match(md, /2026-10-02/);
});

test('study.renderIndex：没有目标时给引导而不是空文件', () => {
  const md = study.renderIndex([]);
  assert.match(md, /还没有定向学习目标/);
  assert.match(md, /world\/README\.md/);
});

// ---------- scanAndAppend：日报流水线接入点 ----------

test('study.scanAndAppend：未配置 techstack 时零副作用（返回 null，不建目录）', () => {
  const root = tmpDir();
  const res = study.scanAndAppend({ meta: { date: '2026-10-07' }, techTips: [{ topic: 'IPC' }] }, { root, goals: [] });
  assert.equal(res, null, '没配目标必须直接返回 null');
  assert.equal(fs.readdirSync(root).length, 0, '一个文件都不该创建');
});

test('study.scanAndAppend：日期非法时不动盘', () => {
  const root = tmpDir();
  assert.equal(study.scanAndAppend({ meta: {}, techTips: [{ topic: 'IPC' }] }, { root, goals: GOALS }), null);
  assert.equal(fs.readdirSync(root).length, 0);
});

test('study.scanAndAppend：日报有考点时建档 + 回填 + 写总览', () => {
  const root = tmpDir();
  const res = study.scanAndAppend(
    { meta: { date: '2026-10-07' }, techTips: [{ topic: 'electron 主进程 IPC 通信设计', answer: '主进程持有状态。' }] },
    { root, goals: GOALS },
  );
  assert.ok(res);
  assert.equal(res.created.length, 3, '三个关键词都建档（没命中的那些也要有空白区）');
  assert.equal(res.written.length, 1, '只有命中的被回填');
  assert.ok(fs.existsSync(res.indexFile));
  assert.equal(res.cards.length, 3);

  // 未命中的那张卡：建档了但明确说还在等
  const pending = res.cards.find((c) => c.kwId === 'kw-cccc0003');
  assert.equal(pending.dayCount, 0);
  assert.equal(pending.status, card.STATUS.pending);
  const hit = res.cards.find((c) => c.kwId === 'kw-aaaa0001');
  assert.equal(hit.dayCount, 1);
  assert.equal(hit.status, card.STATUS.learning);
});

test('study.scanAndAppend：techTips 为空的一天也要建档（日报 md 不生成，卡片要在）', () => {
  const root = tmpDir();
  const res = study.scanAndAppend({ meta: { date: '2026-10-08' }, techTips: [] }, { root, goals: GOALS });
  assert.ok(res, '空 tips 也照常建档');
  assert.equal(res.created.length, 3);
  assert.equal(res.written.length, 0);
  assert.match(fs.readFileSync(res.cards[0].file, 'utf8'), /## 🧩 空白区/);
});

test('study.scanAndAppend：ensure:false 时只回填、不建档', () => {
  const root = tmpDir();
  const res = study.scanAndAppend(
    { meta: { date: '2026-10-07' }, techTips: [{ topic: 'electron 主进程 IPC 通信设计' }] },
    { root, goals: GOALS, ensure: false },
  );
  assert.equal(res.created.length, 0, '不建档');
  assert.equal(res.written.length, 1, '但命中的仍会自己建档并写入');
});

test('study.syncRecent：把历史日报里从没进卡片的考点补回来', () => {
  const outDir = tmpDir('dwout-');
  const root = tmpDir();
  // 老数据形态：日报里是字符串 tip（10-05 真实数据就是这样）
  fs.writeFileSync(
    path.join(outDir, 'daily-2026-10-05.json'),
    JSON.stringify({ meta: { date: '2026-10-05' }, techTips: [{ topic: 'electron 主进程 IPC 通信设计', answer: '旧答案' }] }),
  );
  fs.writeFileSync(
    path.join(outDir, 'daily-2026-10-06.json'),
    JSON.stringify({ meta: { date: '2026-10-06' }, techTips: [{ topic: 'electron 主进程 IPC 通信设计', answer: '新答案' }] }),
  );
  fs.writeFileSync(path.join(outDir, 'daily-broken.json'), '{{{');
  fs.writeFileSync(path.join(outDir, 'daily-2020-01-01.json'), JSON.stringify({ meta: { date: '2020-01-01' }, techTips: [{ topic: '太旧了' }] }));

  const r = study.syncRecent({ days: 7, root, goals: GOALS, outDirs: [outDir] });
  assert.ok(r.written.length >= 1, '应至少补一张卡');
  assert.ok(r.days.includes('2026-10-05'), '历史那两天都被读到');
  assert.ok(r.days.includes('2026-10-06'));
  assert.ok(!r.days.includes('2020-01-01'), '超出回看窗口的日报不进卡片');

  const file = path.join(root, GOALS[0].id, 'kw-aaaa0001.md');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /旧答案/, '10-05 的历史欠账补回来了');
  assert.match(body, /新答案/);

  // 再 sync 一次：幂等，不重复追加
  study.syncRecent({ days: 7, root, goals: GOALS, outDirs: [outDir] });
  assert.equal(fs.readFileSync(file, 'utf8'), body, '二次 sync 内容不变');
});

test('study.syncRecent：没配目标时零副作用', () => {
  const root = tmpDir();
  const r = study.syncRecent({ days: 7, root, goals: [], outDirs: [tmpDir()] });
  assert.equal(r.goals, 0);
  assert.equal(fs.readdirSync(root).length, 0);
});

test('study.pickRecentByDay：按日期窗口取，而不是"最后 N 个文件"', () => {
  const entries = [
    { f: 'daily-2020-01-01.json', date: '2020-01-01' },
    { f: 'daily-2026-10-05.json', date: '2026-10-05' },
    { f: 'daily-2026-10-06.json', date: '2026-10-06' },
    { f: 'daily-2026-10-07.json', date: '2026-10-07' },
  ];
  assert.equal(study.pickRecentByDay(entries, 7).length, 3, '2020 那份被日期窗口排除（数量切片会误收）');
  assert.equal(study.pickRecentByDay(entries, 2).map((e) => e.date).join(','), '2026-10-06,2026-10-07');
  assert.equal(study.pickRecentByDay(entries, 1).map((e) => e.date).join(','), '2026-10-07', 'days=1 只要最新一天');
  assert.deepEqual(study.pickRecentByDay([], 7), []);
  assert.deepEqual(study.pickRecentByDay(entries, 0), [], 'days<1 不取');
  //跨月与跨年边界
  assert.deepEqual(study.pickRecentByDay([{ f: 'x', date: '2026-01-01' }, { f: 'y', date: '2026-12-31' }], 1).map((e) => e.date), ['2026-12-31']);
  assert.deepEqual(study.pickRecentByDay([{ f: 'x', date: '2026-03-01' }, { f: 'y', date: '2026-02-27' }], 3).map((e) => e.date), ['2026-02-27', '2026-03-01'], '跨月回看，仍是升序');
});

test('study.shiftDay：UTC 算术，跨月跨年不出错', () => {
  assert.equal(study.shiftDay('2026-10-07', -1), '2026-10-06');
  assert.equal(study.shiftDay('2026-10-01', -1), '2026-09-30');
  assert.equal(study.shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(study.shiftDay('2026-03-01', -3), '2026-02-26', '2026 非闰年');
  assert.equal(study.shiftDay('不是日期', -1), '不是日期', '坏输入原样返回，不抛');
});

// ---------- normalizeTechTips 语义变更（v0.7） ----------

test('normalizeTechTips：空输入返回 []（不是 undefined）——让调用方能区分"没料"与"坏了"', () => {
  assert.deepEqual(normalizeTechTips([]), []);
  assert.deepEqual(normalizeTechTips('not-array'), []);
  assert.deepEqual(normalizeTechTips([null, 42, { noTopic: 1 }, '   ']), []);
  // 非空行为不变
  assert.equal(normalizeTechTips(['普通字符串 tip']).length, 1);
  assert.equal(normalizeTechTips([{ topic: 'IPC 设计' }])[0].topic, 'IPC 设计');
});

test('日报 tips md 的既有生成条件不受影响（[] 与 undefined 在 .length 判断上等价）', () => {
  const { writeDayNotes } = require('../world/pipeline');
  const dir = tmpDir();
  const empty = writeDayNotes(dir, { meta: { date: '2026-10-08' }, source: 'claude', blockers: [], techTips: [] });
  assert.deepEqual(empty, [], '空 techTips 依旧不写 tips md（老行为不变）');
  const withTips = writeDayNotes(dir, {
    meta: { date: '2026-10-08' },
    source: 'claude',
    techTips: [{ topic: 'IPC 设计', answer: 'a' }],
  });
  assert.equal(withTips.length, 1, '有料照常写');
  assert.match(fs.readFileSync(withTips[0], 'utf8'), /【考点】IPC 设计/);
});

// ---------- 集成守门 ----------

test('pipeline 接入：runDaily 之后调用 study.scanAndAppend（源码级守门）', () => {
  const src = fs.readFileSync(require.resolve('../world/pipeline'), 'utf8');
  const callAt = src.indexOf('scanAndAppend');
  assert.ok(callAt > 0, 'runDaily 里必须接学习卡片');
  // 必须在 writeDayNotes 之后，且包在 try/catch 里（增量功能不能打断日报）
  assert.ok(callAt > src.indexOf('writeDayNotes(outDir, report)'), '回填在随笔 md 之后');
  const guardAt = src.lastIndexOf('try {', callAt);
  assert.ok(guardAt > 0 && guardAt < callAt, '回填必须被 try 包住');
  assert.match(src, /学习卡片回填失败/);
});

test('日报写入路径与卡片路径互相独立（卡片不跟 outDir 走）', () => {
  // 卡片在 ~/.desktop-world/study/（或 WORLD_STUDY_DIR），日报在 outDir —— App 与 CLI 的 outDir 不同，
  // 卡片若跟着 outDir 走就会分裂成两份，--sync 补不上 App 那份。
  const index = require.resolve('../world/study/index');
  const src = fs.readFileSync(index, 'utf8');
  assert.match(src, /WORLD_STUDY_DIR/);
  assert.ok(!/STUDY_DIR\s*=\s*outDir/.test(src), 'STUDY_DIR 不得依赖 outDir');
});

// ---------- 动态桌面 UI 接线 ----------

test('live/preload：只新增 __worldStudy 一个最小面（列卡片 / 开卡片 / 开总览）', () => {
  const src = fs.readFileSync(require.resolve('../world/live/preload'), 'utf8');
  assert.match(src, /exposeInMainWorld\('__worldStudy'/);
  for (const fn of ['list', 'open', 'openIndex']) {
    assert.match(src, new RegExp(`${fn}:.*world:study:`), `${fn} 应走独立 IPC 通道`);
  }
  // 渲染层不得拿到文件系统能力
  assert.ok(!/readFileSync|writeFileSync|require\(/.test(src.split('__worldStudy')[1] || ''), 'study 面不得暴露文件读写');
});

test('live：study IPC 只放行 STUDY_DIR 之下的已存在文件（渲染层传参不可信）', () => {
  const src = fs.readFileSync(require.resolve('../world/live/live'), 'utf8');
  assert.match(src, /world:study:list/);
  assert.match(src, /world:study:open/);
  assert.match(src, /world:study:open-index/);
  // 白名单校验：必须做 resolve + 前缀包含判断，且开文件前查存在
  assert.match(src, /studyInside/);
  assert.match(src, /path\.resolve/);
  assert.match(src, /fs\.existsSync\(abs\)/);
  // 三个 handler 都要过 ok(e) 校验（只服务本窗口 webContents）
  const handlers = src.match(/ipcMain\.handle\('world:study:[^']+'/g) || [];
  assert.equal(handlers.length, 3);
  for (const h of handlers) {
    const at = src.indexOf(h);
    const body = src.slice(at, at + 400);
    assert.match(body, /if \(!ok\(e\)\)/, `${h} 必须校验事件来源`);
  }
});

test('daily-card：学习卡片区只在 live 出现，bake 形态完全不含', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'world', 'template', 'daily-card.html'), 'utf8');
  assert.match(html, /id="studySection"/);
  // bake 必须被 CSS 硬关掉（这是既有契约：烘焙 PNG 里不能出现 live 专属板块）
  assert.match(html, /body\.bake \.study \{ display: none !important; \}/);
  assert.match(html, /body\.live \.study \{/);
  // 开启处必须有 LIVE 守卫
  const at = html.indexOf("document.getElementById('studySection').hidden = false;");
  assert.ok(at > 0, '找不到区块开启处');
  assert.match(html.slice(Math.max(0, at - 300), at), /if \(LIVE && window\.__worldStudy\)/, '必须仅 live 开启');
});

test('daily-card：studyInit 独立于 techInit（否则卡片列表永远拉不到）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'world', 'template', 'daily-card.html'), 'utf8');
  assert.match(html, /var studyInit = false;/);
  const at = html.indexOf("document.getElementById('studySection').hidden = false;");
  const body = html.slice(at, at + 220);
  assert.match(body, /if \(!studyInit\)/, '学习卡片区必须用studyInit，不能被 techInit 抢先置位');
  assert.match(html, /function refreshStudyCards\(\)/, '列表渲染函数必须存在');
});

test('daily-card：卡片文本经 esc 转义后才进 DOM（关键词是模型/用户给的自由文本）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'world', 'template', 'daily-card.html'), 'utf8');
  const at = html.indexOf('function refreshStudyCards()');
  assert.ok(at > 0);
  const body = html.slice(at, html.indexOf('function submitTechDirection', at));
  assert.match(body, /esc\(c\.keyword\)/, '关键词必须转义');
  assert.match(body, /esc\(days\)/);
  assert.ok(!/innerHTML = c\.keyword/.test(body), '不得裸拼用户文本');
  // 未建档的卡片不可点（file 为空时不绑定 open）
  assert.match(body, /if \(!c\.file\)/);
});
