import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = join(__dirname, '..', 'src', 'data', 'content.js');

const REQUEST_TIMEOUT = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripTags(html, keepTags = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote']) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  const allowed = new Set(keepTags.map(t => t.toLowerCase()));
  s = s.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (match, tag) => {
    const t = tag.toLowerCase();
    if (allowed.has(t)) return match;
    return ' ';
  });
  return s;
}

function cleanHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ');
}

function extractCandidateBlocks(html) {
  const candidates = [];
  const selectors = [
    { regex: /<article[\s\S]*?<\/article>/gi, weight: 10 },
    { regex: /<main[\s\S]*?<\/main>/gi, weight: 8 },
    { regex: /<div[^>]*class=["'][^"']*?(?:content|article|post|main-body|detail|entry)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, weight: 6 },
    { regex: /<section[^>]*class=["'][^"']*?(?:content|article|post|detail)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi, weight: 5 },
  ];

  for (const { regex, weight } of selectors) {
    const matches = html.matchAll(regex);
    for (const m of matches) {
      const text = m[0].replace(/<[^>]+>/g, '');
      candidates.push({ html: m[0], text, weight, len: text.length });
    }
  }

  candidates.sort((a, b) => (b.len * b.weight) - (a.len * a.weight));
  return candidates.map(c => c.html);
}

function isNoiseParagraph(p) {
  const text = p.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!text) return true;
  if (text.length < 15) return true;
  if ((text.match(/&nbsp;/g) || []).length * 6 / text.length > 0.3) return true;
  const noisePatterns = [
    /网站简介\s*[|｜]\s*版权声明\s*[|｜]\s*联系方式/,
    /版权所有[:：]/,
    /主办[:：]/,
    /^(点赞\s*\+1|微博|微信|分享)$/,
    /^\d+\s*[\.、]\s*.+?(推荐|排行榜|攻略|测评|解读|实测)/,
    /(宠物鱼油|板材十大|证券开户|窗帘品牌|燕窝哪个|高中网课|建军|强军)/,
  ];
  return noisePatterns.some(re => re.test(text));
}

function paragraphsFromHtml(html) {
  const stripped = stripTags(html);
  const textNodes = stripped.split(/(<\/?(?:p|h[1-6]|ul|ol|li|blockquote)[^>]*>)/gi);
  const paragraphs = [];
  let current = '';
  for (const part of textNodes) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^<\/?(p|h[1-6]|ul|ol|li|blockquote)/i.test(trimmed)) {
      if (current.trim()) paragraphs.push(current.trim());
      current = '';
    } else {
      current += part;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs.filter(p => {
    const textOnly = p.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return textOnly.length >= 15 && textOnly.replace(/[^\u4e00-\u9fa5]/g, '').length >= 8 && !isNoiseParagraph(p);
  });
}

function normalizeParagraph(p) {
  let s = p
    .replace(/<\/?(?!p|strong|em|b|i|h[1-6]|ul|ol|li|blockquote)[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (!/^<[^>]+>/.test(s)) s = `<p>${s}</p>`;
  return s;
}

export async function extractArticleContent(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = cleanHtml(await resp.text());

      const candidates = extractCandidateBlocks(html);
      let paragraphs = [];
      for (const candidate of candidates) {
        paragraphs = paragraphsFromHtml(candidate);
        if (paragraphs.length >= 3) break;
      }

      if (paragraphs.length === 0) {
        paragraphs = paragraphsFromHtml(html);
      }

      if (paragraphs.length === 0) {
        return null;
      }

      const content = paragraphs.map(normalizeParagraph).filter(Boolean).join('\n');
      if (content.length < 80) return null;

      await sleep(300);
      return content;
    } catch (e) {
      if (attempt === retries) {
        console.log(`  [Extractor] ⚠ 抓取失败 (${url}): ${e.message}`);
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
