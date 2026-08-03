import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = join(__dirname, '..', 'src', 'data', 'content.js');

const REQUEST_TIMEOUT = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 解码常见 HTML 实体 */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&ldquo;/g, '「')
    .replace(/&rdquo;/g, '」')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, m => {
      try { return String.fromCharCode(parseInt(m.slice(2, -1))); } catch { return m; }
    });
}

/** 清理 script/style/nav/header/footer/aside/comment */
function sanitizeHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<\/?noindex[^>]*>/gi, ' ');
}

/** 尝试从正文候选区提取 */
function extractContentArea(html) {
  const selectors = [
    /<article[^>]*>[\s\S]*?<\/article>/gi,
    /<main[^>]*>[\s\S]*?<\/main>/gi,
    /<div[^>]*class=["'][^"']*?(?:content|article|post|main-body|detail|entry|main-content|article-content|article_body|cont|cnt)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    /<section[^>]*class=["'][^"']*?(?:content|article|post|detail)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi,
    /<div[^>]*id=["'][^"']*?(?:content|article|post|detail|main)["'][^>]*>[\s\S]*?<\/div>/gi,
  ];

  let best = '';
  let bestScore = 0;
  for (const regex of selectors) {
    const matches = html.matchAll(regex);
    for (const m of matches) {
      const text = m[0].replace(/<[^>]+>/g, '');
      const score = text.length;
      if (score > bestScore) {
        bestScore = score;
        best = m[0];
      }
    }
  }
  return best || html;
}

const NOISE_PATTERNS = [
  /当前位置[:：]/,
  /来源[:：]/,
  /编辑[:：]/,
  /记者[:：]/,
  /作者[:：]/,
  /原标题[:：]/,
  /(发布时间|发布日期|时间)[:：]/,
  /(信息来源|消息来源|文章来源)[:：]/,
  /(字体[:：]|字号[:：]|大\s*中\s*小|小\s*中\s*大)/,
  /(网站简介|版权声明|联系方式|关于我们|免责声明|投稿|广告服务|加入我们)/,
  /版权所有/,
  /主办单位/,
  /承办单位/,
  /协办单位/,
  /技术支持/,
  /(百度首页|登录|搜索|复制|举报|反馈|分享至|微信好友|新浪微博|复制链接|扫码分享)/,
  /(中国政府网|河北省人民政府|保定市人民政府|网站首页|设为首页|加入收藏|无障碍|长者模式|互动交流)/,
  /更多精彩资讯请在应用市场下载/,
  /欢迎提供新闻线索/,
  /24小时报料热线/,
  /消费者也可通过/,
  /啄木鸟消费者投诉平台/,
  /版权声明：/,
  /不尊重原创的行为我们将追究责任/,
  /转载请联系/,
  /手机看\s*$|手机看更方便/,
  /\[email\s+protected\]/,
  /(宠物鱼油|板材十大|证券开户|窗帘品牌|燕窝哪个|高中网课)/,
  /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(央广网|新浪|网易|搜狐|凤凰|腾讯|中新网|新华网|人民网)/,
  /^\d{4}年\d{1,2}月\d{1,2}日\s+\d{2}:\d{2}/,
  /^\d{2}:\d{2}\s+(来源|原创)/,
  /(举报\s*\/\s*反馈|投诉|热线|客服|\d{3,4}-\d{7,8})/,
  /^\s*\d+\s*$/,
  /^\s*[A-Z]{2,}\d{0,2}\s*$/,
  /^(上一篇|下一篇|下一页|上一页|责任编辑)([:：]|$)/,
  /(来源[:：]\s*(河北日报|燕赵都市报|保定晚报|保定日报|长城网|河北新闻网|新华社|中国新闻网|央广网|人民网|新华网|光明网|经济日报|农民日报))$/,
  /(首页\s*>>\s*|新闻中心\s*>>\s*|今日易县)/,
  /^(回放|直播|更多视频|精彩推荐|热门推荐|猜你喜欢|相关阅读)/,
  /冀ICP备\d+号/,
];

function isNoise(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 20) return true;
  if (/^[\s|｜\-—_]+$/.test(t)) return true;
  return NOISE_PATTERNS.some(re => re.test(t));
}

/** 把候选 HTML 拆成段落 */
function paragraphsFromHtml(html) {
  const result = [];
  const parts = html.split(/(<\/?(?:p|h[1-6]|li|br)[^>]*>)/gi);
  let buffer = '';

  function flush() {
    const raw = buffer.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
    const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (text && !isNoise(text)) {
      result.push(text);
    }
    buffer = '';
  }

  for (const part of parts) {
    if (/^<\/p>/i.test(part) || /^<br/i.test(part)) {
      buffer += ' ';
      flush();
    } else if (/^<(?:p|h[1-6]|li)[^>]*>/i.test(part)) {
      flush();
    } else {
      buffer += part;
    }
  }
  flush();

  // 如果只得到 1-2 个段落，尝试按句号/分号分割
  if (result.length <= 2) {
    const expanded = [];
    for (const r of result) {
      const sentences = r.split(/(?<=[。！？])\s*/);
      for (const s of sentences) {
        const t = s.trim();
        if (t && !isNoise(t)) expanded.push(t);
      }
    }
    if (expanded.length > result.length) return expanded;
  }

  return result;
}

/** 清理段落中的噪声 */
function cleanParagraphNoise(paragraphs) {
  return paragraphs.map(p => {
    // 去掉"百度首页 登录 搜索 复制"
    p = p.replace(/^百度首页\s+登录\s+搜索\s+复制\s*/g, '');
    // 去掉开头纯数字+空格
    p = p.replace(/^\s*\d+\s+/, '');
    // 去掉末尾的"手机看"等
    p = p.replace(/手机看\s*(百度APP扫一扫\s*)?手机看更方便?$/g, '');
    // 去掉开头的"（来源：XXX）"
    p = p.replace(/^[（(]来源[:：][^）)]*[）)]\s*/g, '');
    return p.trim();
  }).filter(p => {
    if (p.length < 20) return false;
    const chineseChars = p.replace(/[^\u4e00-\u9fa5]/g, '').length;
    if (chineseChars < 10) return false;
    return true;
  });
}

/** 用转义后的安全文本生成 HTML 段落 */
function makeParagraph(text) {
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<p>${safe}</p>`;
}

/** 生成转载声明 */
function makeAttribution(sourceName, sourceUrl) {
  const parts = [
    `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;color:#888;font-size:0.85rem;">`,
    `本文内容由 <strong>${sourceName || '网络'}</strong> 公开发布，`,
    `本站进行自动采集、整理与转载。`,
  ];
  if (sourceUrl) {
    parts.push(`原文链接：<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceUrl}</a>`);
  }
  parts.push(`如涉侵权请联系删除。</p>`);
  return parts.join('');
}

export async function extractArticleContent(sourceName, sourceUrl, retries = 2) {
  let resolvedUrl = sourceUrl;
  try {
    if (sourceUrl.startsWith('/link?') || sourceUrl.startsWith('http')) {
      const u = new URL(sourceUrl, 'https://www.baidu.com');
      const real = u.searchParams.get('url');
      if (real) resolvedUrl = decodeURIComponent(real);
    }
  } catch {}

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = sanitizeHtml(await resp.text());
      const area = extractContentArea(html);
      let paragraphs = paragraphsFromHtml(area);
      if (paragraphs.length < 2) {
        paragraphs = paragraphsFromHtml(html);
      }

      // 进一步清洗：去掉噪声段落
      paragraphs = cleanParagraphNoise(paragraphs);

      // 再次过滤：必须有一定中文含量
      paragraphs = paragraphs.filter(p => {
        const charCount = p.replace(/[^\u4e00-\u9fa5]/g, '').length;
        return charCount >= 15 || p.length >= 30;
      });

      if (paragraphs.length === 0) return null;

      const body = paragraphs.map(makeParagraph).join('\n');
      const attribution = makeAttribution(sourceName, resolvedUrl);
      const content = `${body}\n${attribution}`;

      if (body.replace(/<[^>]+>/g, '').length < 60) return null;

      await sleep(200);
      return content;
    } catch (e) {
      if (attempt === retries) {
        console.log(`  [Extractor] 抓取失败 (${resolvedUrl}): ${e.message}`);
        return null;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

export function loadContentMap() {
  try {
    const text = readFileSync(CONTENT_PATH, 'utf-8');
    const map = {};
    const regex = /'([^']+)':\s*`([\s\S]*?)`\s*,?\s*(?=\n\s*'|};)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      map[m[1]] = m[2];
    }
    return { map, raw: text };
  } catch (e) {
    return { map: {}, raw: 'export const contentMap = {\n};\n' };
  }
}

export function saveContentMap(map) {
  const entries = Object.entries(map).map(([slug, content]) => {
    const escaped = content.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `  '${slug}': \`${escaped}\`,`;
  });
  const output = `export const contentMap = {\n${entries.join('\n')}\n};\n`;
  writeFileSync(CONTENT_PATH, output, 'utf-8');
}

export function appendContentForArticle(slug, content) {
  const { map } = loadContentMap();
  map[slug] = content;
  saveContentMap(map);
}
