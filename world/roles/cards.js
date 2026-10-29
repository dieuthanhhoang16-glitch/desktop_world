// world/roles/cards.js
// desktop-world · 角色卡的读与写（编排台 R2：角色 tab 与 executor 模型兜底的数据面）。
//
// 为什么单独立模块：launcher 管「启动前的隔离与围栏」，defaults 管编译期模板；
// R2 起编排台要列出/编辑这三张卡（含默认模型），读写规则（模板同构、manifest
// 重建、漂移归零）需要一个纯 Node 的家：无 electron、无状态、全部入参显式给 root。
//
// 形状约定：
//   卡内「- 默认模型：X（…）」一行是唯一可机改的字段；其余文本整体交给用户编辑。
//   任何写操作后必须立刻重建 manifest（hash 对齐），否则 checkRoles 报漂移。
'use strict';

const fs = require('fs');
const path = require('path');

const { ROLES, roleCard } = require('./defaults');
const launcher = require('./launcher');

const MODEL_LINE_RE = /^- 默认模型：(.*)$/m;
const RUNTIME_LINE_RE = /^- 运行时：(.*)$/m;
const NETWORK_LINE_RE = /^- 网络：(.*)$/m;
// 与 roleCard() 模板同构的模型行后缀（写卡时逐字复刻，读者解析时宽容容忍缺省）
const MODEL_NOTE = '（任务级可覆盖，职责与权限不可覆盖）';

function problem(code, reason, fix) {
  return { ok: false, problems: [{ code, reason, fix }] };
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function cardFile(root, id) {
  return path.join(root, 'cards', `${id}.md`);
}

/** 从卡正文解析「- 字段：值」行；缺行/空值回退编译默认（宽容，不抛）。 */
function fieldOf(body, re, fallback) {
  const m = re.exec(String(body || ''));
  if (!m) return fallback;
  const v = String(m[1]).split('（')[0].trim();
  return v || fallback;
}

function defaultModelOf(id, body) {
  return fieldOf(body, MODEL_LINE_RE, (ROLES[id] && ROLES[id].defaultModel) || '');
}

/**
 * 列出三张角色卡 + 漂移状态 + manifest。
 * @returns {{ok:true, roles:Array<{id,title,runtime,network,model,body,cardFile}>, drift:Array, manifest:object|null}}
 */
function listRoleCards({ root } = {}) {
  const r = launcher.rolesRoot(root);
  const check = launcher.checkRoles({ root: r });
  const roles = Object.keys(ROLES).map((id) => {
    const file = cardFile(r, id);
    const body = readSafe(file);
    return {
      id,
      title: ROLES[id].title,
      runtime: fieldOf(body, RUNTIME_LINE_RE, ROLES[id].runtime),
      network: fieldOf(body, NETWORK_LINE_RE, ROLES[id].network),
      model: defaultModelOf(id, body),
      body,
      cardFile: file,
    };
  });
  return { ok: true, roles, drift: check.drift, manifest: check.manifest };
}

/**
 * 把模型值写进卡正文：有「- 默认模型：」行就原地换值；没有就按 roleCard() 模板位
 * 插入（默认模型 ← 网络 之前；再找不到锚点退到 运行时 行后；都没有才追加文末）。
 */
function withModel(body, model) {
  const line = `- 默认模型：${model}${MODEL_NOTE}`;
  let text = String(body || '');
  if (MODEL_LINE_RE.test(text)) return text.replace(MODEL_LINE_RE, line);
  const networkLine = /^- 网络：.*$/m.exec(text);
  if (networkLine) return `${text.slice(0, networkLine.index)}${line}\n${text.slice(networkLine.index)}`;
  const runtimeLine = /^- 运行时：.*$/m.exec(text);
  if (runtimeLine) {
    const at = runtimeLine.index + runtimeLine[0].length;
    return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
  }
  if (!text.endsWith('\n')) text += '\n';
  return `${text}${line}\n`;
}

/** manifest 重建落盘（与 initRoles 同纪律：0700 目录 + tmp 文件 rename + 0600）。 */
function writeManifest(root) {
  const manifest = launcher.buildManifest(root);
  const file = path.join(root, launcher.MANIFEST);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return manifest;
}

/**
 * 保存角色卡：cardBody 存在则整体重写卡文件；model 存在则换默认模型行（可同传，
 * 先整卡再换模型）。写后重建 manifest，返回最新列表与漂移（正常应为空）。
 * @returns {ok:true, roles, drift} | {ok:false, problems[]}
 */
function saveRoleCard({ root, id, cardBody, model } = {}) {
  const r = launcher.rolesRoot(root);
  const roleId = String(id || '');
  if (!ROLES[roleId]) {
    return problem('role-unknown', `未知角色：${roleId}`, `角色白名单：${Object.keys(ROLES).join(' / ')}`);
  }
  if (cardBody == null && model == null) {
    return problem('card-nothing-to-save', '既没有卡正文也没有模型，没什么可保存的', '至少改一处再保存');
  }
  if (cardBody != null && !String(cardBody).trim()) {
    return problem('card-body-empty', '角色卡不能是空白', '卡至少要留下职责/允许/禁止/交付——参照 roleCard() 模板');
  }
  if (model != null && !String(model).trim()) {
    return problem('model-empty', '模型名是空的', '直接给出模型 id（如 jd-glm53），或干脆别传 model 字段');
  }
  const nextBody = cardBody != null
    ? (String(cardBody).endsWith('\n') ? String(cardBody) : `${cardBody}\n`)
    : (readSafe(cardFile(r, roleId)) || `${roleCard(roleId)}\n`);
  const finalBody = model != null ? withModel(nextBody, String(model).trim()) : nextBody;
  const file = cardFile(r, roleId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, finalBody, { mode: 0o600 });
  writeManifest(r);
  const listed = listRoleCards({ root: r });
  return { ok: true, roles: listed.roles, drift: listed.drift };
}

/** 读某角色的卡内默认模型（run 缺省 model 时的兜底）。未知角色 → null。 */
function readRoleModel({ root, id } = {}) {
  const roleId = String(id || '');
  if (!ROLES[roleId]) return null;
  const r = launcher.rolesRoot(root);
  return defaultModelOf(roleId, readSafe(cardFile(r, roleId)));
}

module.exports = { listRoleCards, saveRoleCard, readRoleModel, withModel };
