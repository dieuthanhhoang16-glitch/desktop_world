// test/world-cleanup.test.js
// 清理：只读扫描/四类候选/护栏，JEV 一轮，GLM 一次性 worktree 二轮，三桶提案，
// 审批决策，dry-run/执行/恢复/到期清除。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { scanProject } = require('../world/cleanup/scan');
const { runRound1 } = require('../world/cleanup/round1');
const { runRound2 } = require('../world/cleanup/round2');
const { buildProposal, writeProposal, readProposal } = require('../world/cleanup/proposal');
const { buildDecisions, writeDecisions } = require('../world/cleanup/decisions');
const { execute, restore, purge, safeRel } = require('../world/cleanup/execute');
const { proposalDir } = require('../world/cleanup/paths');

const DAY = 24 * 3600 * 1000;

function tmpDir(prefix = 'dwclean-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function aged(root, rel, days) {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(path.join(root, rel), t, t);
}

function git(dir, args, env = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir, commitDate) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  const env = commitDate ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } : {};
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'fixture'], env);
}

/** 旧仓库：重复、未引用、生成物、长期未动各一，外加近期/密钥/依赖/ticket 范围护栏。 */
function cleanupFixture() {
  const dir = tmpDir('dwclean-proj-');
  write(dir, 'README.md', '# fixture\n\nsee docs/ancient.md\n');
  write(dir, 'docs/a.md', 'duplicate body\n');
  write(dir, 'docs/a.bak.md', 'duplicate body\n');
  write(dir, 'notes/orphan.md', '# orphan\n\nnobody references me.\n');
  write(dir, 'dist/app.min.js', 'console.log(1)\n');
  write(dir, 'docs/ancient.md', '# ancient\n\nold notes.\n');
  write(dir, 'docs/fresh.md', '# fresh\n\njust edited.\n');
  write(dir, 'docs/scoped.md', '# scoped\n\ncurrent ticket.\n');
  write(dir, 'docs/ignored-superseded.txt', 'old\n');
  write(dir, '.scratch/feat/issues/01.md', '# 01: current\n\nStatus: ready-for-agent\n\n- [ ] 处理 docs/scoped.md 与 docs/ignored-superseded.txt\n');
  write(dir, '.env', 'SECRET=1\n');
  write(dir, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  const old = new Date(Date.now() - 400 * DAY).toISOString();
  initRepo(dir, old);
  for (const rel of ['README.md', 'docs/a.md', 'docs/a.bak.md', 'notes/orphan.md', 'dist/app.min.js', 'docs/scoped.md', 'docs/ignored-superseded.txt', '.scratch/feat/issues/01.md', '.env', 'node_modules/pkg/index.js']) {
    aged(dir, rel, 30);
  }
  aged(dir, 'docs/ancient.md', 400);
  aged(dir, 'docs/fresh.md', 0);
  return dir;
}

function snapshot(root) {
  const out = new Map();
  function rec(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) rec(child);
      else {
        const abs = path.join(root, child);
        out.set(child, `${fs.readFileSync(abs).toString('base64')}@${fs.statSync(abs).mtimeMs}`);
      }
    }
  }
  rec('');
  return out;
}

test('扫描：四类候选齐全，近 14 天/当前 ticket/密钥/依赖被排除，且完全不写项目', () => {
  const project = cleanupFixture();
  const before = snapshot(project);
  const result = scanProject(project);

  assert.equal(result.ok, true);
  assert.equal(result.isGit, true);
  const paths = result.candidates.map((c) => c.path);
  assert.ok(paths.includes('docs/a.bak.md'), '重复文件应成为候选');
  assert.ok(paths.includes('notes/orphan.md'), '未引用文件应成为候选');
  assert.ok(paths.includes('dist/app.min.js'), '生成物应成为候选');
  assert.ok(paths.includes('docs/ancient.md'), '长期未动文件应成为候选');
  assert.ok(!paths.includes('docs/a.md'), '重复组的保留者不进候选');
  assert.ok(!paths.includes('docs/fresh.md'), '近 14 天修改不进候选');
  assert.ok(!paths.includes('docs/scoped.md'), '当前 ticket 范围内文件不进候选');
  assert.ok(!paths.includes('.env'), '密钥不进候选');
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), '依赖目录不扫描');
  assert.ok(result.counts.duplicate >= 1 && result.counts.unreferenced >= 1 && result.counts.generated >= 1 && result.counts.stale >= 1);
  for (const c of result.candidates) {
    assert.ok(c.evidenceLines.length >= 2, `${c.path} 至少两项证据`);
    assert.ok(c.risk);
  }
  assert.ok(result.params && result.exclusions);
  assert.ok(result.exclusions.ticketScope.includes('docs/scoped.md'));
  assert.deepEqual(snapshot(project), before, '扫描不得修改项目');
});

test('JEV 一轮：没有 JEV 不生成提案；有 JEV 只调用一次并落盘扫描参数/风险/理由', async () => {
  const project = cleanupFixture();
  const root = tmpDir('dwclean-root-');
  const scan = scanProject(project);

  const none = await runRound1({ projectPath: project, root, scan, decider: undefined });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'jev-unavailable');
  assert.equal(fs.existsSync(path.join(root, require('../world/projects/paths').projectSlug(project))), false);

  let calls = 0;
  const jev = await runRound1({
    projectPath: project,
    root,
    scan,
    now: () => new Date('2026-10-18T00:00:00Z'),
    decider: async ({ questions, purpose }) => {
      calls += 1;
      assert.equal(purpose, 'cleanup-round1');
      const answers = {};
      for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: 0.9 };
      return { ok: true, model: 'jev-test', answers };
    },
  });
  assert.equal(calls, 1);
  assert.equal(jev.ok, true);
  assert.ok(jev.candidates.every((c) => c.votedDelete && c.risk && /概率/.test(c.jevReason)));
  assert.ok(fs.existsSync(path.join(jev.dir, 'scan.json')));
  const round1 = JSON.parse(fs.readFileSync(path.join(jev.dir, 'round1.json'), 'utf8'));
  assert.equal(round1.rounds.jev.calls, 1);
  assert.ok(round1.scanParams && round1.exclusions);
  assert.equal(round1.candidates.length, scan.candidates.length);
});

test('GLM 二轮：一次性只读 worktree、只调用一次、用完即弃；两轮合并三桶', async () => {
  const project = cleanupFixture();
  const root = tmpDir('dwclean-root-');
  const r1 = await runRound1({
    projectPath: project,
    root,
    now: () => new Date('2026-10-18T00:00:00Z'),
    decider: async ({ questions }) => {
      const answers = {};
      for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: 0.95 };
      return { ok: true, model: 'jev-test', answers };
    },
  });
  assert.equal(r1.ok, true);

  let calls = 0;
  let sawReadonly = false;
  const r2 = await runRound2({
    projectPath: project,
    candidates: r1.candidates,
    now: () => new Date('2026-10-18T00:00:00Z'),
    runner: async ({ worktree, prompt }) => {
      calls += 1;
      assert.match(prompt, /delete\|keep\|uncertain/);
      assert.equal(fs.statSync(worktree).mode & 0o200, 0, 'worktree 应为只读');
      sawReadonly = true;
      const verdicts = r1.candidates.map((c) => {
        if (c.category === 'duplicate' || c.category === 'generated') return { path: c.path, verdict: 'delete', evidence: 'rg 无引用' };
        if (c.category === 'unreferenced') return { path: c.path, verdict: 'keep', evidence: 'git log 显示仍在维护' };
        return { path: c.path, verdict: 'uncertain', evidence: '无法判断' };
      });
      return JSON.stringify(verdicts);
    },
  });
  assert.equal(calls, 1);
  assert.equal(sawReadonly, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.calls, 1);
  assert.equal(r2.worktreeRemoved, true);

  const proposal = buildProposal({ round1: r1, round2: r2, now: () => new Date('2026-10-18T00:00:00Z') });
  assert.equal(proposal.status, 'complete');
  const confirmed = proposal.buckets.confirmed.map((i) => i.path);
  const kept = proposal.buckets.keep.map((i) => i.path);
  const pending = proposal.buckets.pending.map((i) => i.path);
  assert.ok(confirmed.includes('docs/a.bak.md'));
  assert.ok(confirmed.includes('dist/app.min.js'));
  assert.ok(kept.includes('notes/orphan.md'));
  assert.ok(pending.includes('docs/ancient.md'));
  assert.ok(proposal.buckets.confirmed.every((i) => /两轮都判 delete/.test(i.bucketReason)));

  const files = writeProposal(r1.dir, proposal);
  const md = fs.readFileSync(files.mdPath, 'utf8');
  assert.match(md, /## 确认删除/);
  assert.match(md, /## 待定/);
  assert.match(md, /## 保留/);
  assert.match(md, /docs\/a\.bak\.md/);
  assert.match(md, /扫描参数与排除项/);
  assert.equal(readProposal(r1.dir).counts.confirmed, confirmed.length);

  const incomplete = buildProposal({
    round1: r1,
    round2: { ok: false, reason: 'glm-unavailable', verdicts: [], model: 'glm', calls: 1 },
  });
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.buckets.confirmed.length, 0, '任何一轮不可用都不能产生确认删除');
  assert.ok(incomplete.buckets.pending.length > 0);
});

test('审批决策：只能勾选确认删除桶；未勾选项不执行；越界路径被拒绝', () => {
  const proposal = {
    schemaVersion: 1,
    proposalId: 'cleanup-demo-2026-10-18',
    project: '/tmp/demo',
    status: 'complete',
    buckets: {
      confirmed: [{ path: 'a.md', tracked: true, bucketReason: '两轮都判 delete' }, { path: 'b.md', tracked: false, bucketReason: '两轮都判 delete' }],
      pending: [{ path: 'c.md', tracked: false, bucketReason: 'uncertain' }],
      keep: [{ path: 'd.md', tracked: false, bucketReason: 'JEV 判保留' }],
    },
  };
  const all = buildDecisions({ proposal, selectAll: true, now: () => new Date('2026-10-18T00:00:00Z') });
  assert.equal(all.ok, true);
  assert.equal(all.decisions.items.filter((i) => i.action === 'delete').length, 2);
  assert.equal(all.decisions.branch, 'cleanup/cleanup-demo-2026-10-18');
  assert.ok(all.decisions.items.find((i) => i.path === 'c.md').action === 'keep');

  const some = buildDecisions({ proposal, selectedPaths: ['a.md'] });
  assert.equal(some.decisions.items.find((i) => i.path === 'b.md').action, 'keep');
  assert.equal(some.decisions.items.find((i) => i.path === 'b.md').reason, '用户未勾选');

  const invalid = buildDecisions({ proposal, selectedPaths: ['c.md'] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'not-confirmed');

  const incomplete = buildDecisions({ proposal: { ...proposal, status: 'incomplete' }, selectAll: true });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'proposal-incomplete');

  assert.equal(safeRel('../escape.md'), null);
  assert.equal(safeRel('/abs.md'), null);
  assert.equal(safeRel('docs/ok.md'), 'docs/ok.md');
});

test('执行器：默认 dry-run；真执行走专用分支 git rm + 回收站；30 天内可恢复；到期才清除', () => {
  const project = tmpDir('dwclean-exec-');
  write(project, 'tracked.txt', 'tracked\n');
  initRepo(project);
  write(project, 'junk.md', 'junk\n');

  const proposal = {
    proposalId: 'cleanup-exec-2026-10-18',
    project,
    status: 'complete',
    buckets: {
      confirmed: [
        { path: 'tracked.txt', tracked: true, bucketReason: '两轮都判 delete' },
        { path: 'junk.md', tracked: false, bucketReason: '两轮都判 delete' },
      ],
      pending: [],
      keep: [],
    },
  };
  const built = buildDecisions({ proposal, selectAll: true, now: () => new Date('2026-10-18T00:00:00Z') });
  const dir = proposalDir(tmpDir('dwclean-root-'), project, '2026-10-18');
  writeDecisions(dir, built.decisions);

  const preview = execute({ projectPath: project, dir, decisions: built.decisions, now: () => new Date('2026-10-18T12:00:00Z') });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.deleteCount, 2);
  assert.ok(fs.existsSync(path.join(project, 'tracked.txt')));
  assert.ok(fs.existsSync(path.join(project, 'junk.md')));

  const frozen = () => new Date('2026-10-18T12:00:00Z');
  const done = execute({ projectPath: project, dir, decisions: built.decisions, dryRun: false, now: frozen });
  assert.equal(done.ok, true);
  assert.equal(done.removed, 1);
  assert.equal(done.moved, 1);
  assert.equal(fs.existsSync(path.join(project, 'tracked.txt')), false);
  assert.equal(fs.existsSync(path.join(project, 'junk.md')), false);
  const receipt = JSON.parse(fs.readFileSync(done.receiptPath, 'utf8'));
  assert.equal(receipt.results.length, 2);
  assert.ok(receipt.results.every((r) => r.destination));
  assert.ok(receipt.results.find((r) => r.path === 'junk.md').recoverableUntil);
  assert.match(receipt.git.branch, /^cleanup\//);
  assert.ok(receipt.git.commit);
  const branches = git(project, ['branch', '--list', receipt.git.branch]);
  assert.match(branches, /cleanup\//);

  const back = restore({ projectPath: project, dir, now: frozen });
  assert.equal(back.ok, true);
  assert.equal(back.restored.length, 2);
  assert.ok(fs.existsSync(path.join(project, 'tracked.txt')));
  assert.ok(fs.existsSync(path.join(project, 'junk.md')));

  // 未勾选：不执行任何动作
  const keepOnly = buildDecisions({ proposal, selectedPaths: [] });
  const noop = execute({ projectPath: project, dir, decisions: keepOnly.decisions, dryRun: false, now: frozen });
  assert.equal(noop.ok, true);
  assert.equal(noop.noop, true);

  // 再删一个未跟踪文件，验证 30 天保留与到期清除
  write(project, 'expired.md', 'expired\n');
  const again = buildDecisions({ proposal: { ...proposal, buckets: { ...proposal.buckets, confirmed: [{ path: 'expired.md', tracked: false, bucketReason: '两轮都判 delete' }] } }, selectAll: true });
  const done2 = execute({ projectPath: project, dir, decisions: again.decisions, dryRun: false, now: frozen });
  assert.equal(done2.moved, 1);
  const early = purge({ projectPath: project, now: frozen });
  assert.equal(early.purged.length, 0);
  assert.equal(early.kept.length, 1);
  const late = purge({ projectPath: project, now: () => new Date('2026-11-20T12:00:00Z') });
  assert.equal(late.purged.length, 1);
  assert.equal(fs.existsSync(path.join(project, '.trash', '2026-10-18')), false);
});
