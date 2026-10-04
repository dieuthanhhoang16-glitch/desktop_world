// world/tidy/classify.js · 桌面文件分类：扩展名规则为主，LLM 兜底"其他"桶。
'use strict';

// 顺序即优先级：命中的第一个桶收走。
const BUCKETS = [
  { id: '安装包', exts: ['dmg', 'pkg', 'exe', 'msi', 'apk', 'ipa'] },
  {
    id: '图片',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'tiff', 'ico', 'raw', 'psd', 'ai'],
  },
  {
    id: '文档',
    exts: ['pdf', 'doc', 'docx', 'pages', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'numbers', 'ppt', 'pptx', 'key', 'csv', 'tsv', 'epub', 'mobi'],
  },
  { id: '音视频', exts: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] },
  { id: '压缩包', exts: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z'] },
  {
    id: '代码',
    exts: ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cc', 'swift', 'kt', 'rb', 'php', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh', 'zsh', 'ipynb', 'vue'],
  },
  { id: '设计稿', exts: ['sketch', 'fig', 'xd', 'blend'] },
];

// 按文件名特征再矫正一遍（扩展名不如名字说明问题时，比如截图）
const NAME_PATTERNS = [
  { re: /^(screenshot|screen shot|截屏|屏幕快照|untitled|image|\d{4}-\d{2}-\d{2}.*截屏)/i, to: '截图' },
  { re: /^(invoice|receipt|发票|报销|行程单|订单)/i, to: '票据' },
];

const OTHER = '其他';

/**
 * @param {Array<{name:string, ext:string}>} files
 * @returns {{groups: Map<string,Array>, others: Array}} groups 按桶序排列
 */
function classifyByRules(files) {
  const groups = new Map();
  const others = [];
  for (const f of files) {
    // 文件名特征优先（截图/票据），其次扩展名
    const named = NAME_PATTERNS.find((p) => p.re.test(f.name));
    const bucket = named
      ? named.to
      : (BUCKETS.find((b) => b.exts.includes(f.ext)) || {}).id || OTHER;
    if (bucket === OTHER) others.push(f);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(f);
  }
  return { groups, others };
}

/**
 * 可选：让本地 claude 给"其他"桶想更贴的分类。（一个会话一次调用，失败则维持"其他"）
 * @param {string[]} names 文件名列表（≤30 个）
 * @param {(prompt:string)=>Promise<string>} runner 形如 summarizer 的 claude -p 执行器；测试可注入假实现
 * @returns {Promise<Map<string,string>>} 文件名 → 类别名
 */
async function refineOthersWithLLM(names, runner) {
  const result = new Map();
  if (!names.length || !runner) return result;
  const prompt = [
    '下面是从桌面"其他"类别里挑出的文件名列表（一行一个）。请判断哪些文件能归入更有意义的类别。',
    '只输出 JSON 对象：{"文件名":"类别名"}，类别名用 2-4 个汉字（如：课件、简历、票据、字体、主题包）。',
    '看不出门道的文件不要列。不要输出任何解释。',
    '',
    ...names.slice(0, 30).map((n) => JSON.stringify(n)),
  ].join('\n');
  try {
    const raw = await runner(prompt);
    const { extractJson } = require('../summarizer');
    const obj = extractJson(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v && v.length <= 8 && names.includes(k)) result.set(k, v);
      }
    }
  } catch {
    /* 兜底：维持"其他" */
  }
  return result;
}

module.exports = { classifyByRules, refineOthersWithLLM, OTHER, BUCKETS };
