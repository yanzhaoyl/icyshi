// ============================================================
// 保定冰柿全平台情报采集器 v3 for icyshi.com
// 用法: node scripts/fetch-news.mjs
// GitHub Actions 每天自动运行
// ============================================================
//
// 新闻渠道 (8 个):
//   1. Bing News RSS        — 微软新闻聚合
//   2. Google News RSS      — 全球新闻聚合
//   3. Baidu News (HTML)    — 国内最大新闻聚合
//   4. Sogou News (HTML)    — 搜狗新闻搜索
//   5. 360 News (HTML)      — 360新闻搜索 ★新增
//   6. 政府网站聚合 (Bing)   — site:gov.cn 保定冰柿 ★新增
//   7. 行业网站聚合 (Bing)   — 果品/食品/农业行业网站 ★新增
//   8. 百度资讯 (news.baidu) — 百度资讯频道 ★新增
//
// 多媒体平台情报 (9 个):
//   9.  淘宝 (taobao.com)    — 通过搜索引擎索引检索
//   10. 京东 (jd.com)        — 通过搜索引擎索引检索
//   11. 拼多多               — 通过搜索引擎索引检索
//   12. 1688 (阿里巴巴)      — 通过搜索引擎索引检索 ★新增
//   13. 抖音                 — 通过搜索引擎索引检索
//   14. 快手                 — 通过搜索引擎索引检索
//   15. 小红书               — 通过搜索引擎索引检索
//   16. 视频号               — 通过搜索引擎索引检索
//   17. 公众号 (weixin.sogou) — 搜狗微信搜索
//
// 18. 盒马鲜生              — 新零售渠道情报
//
// 数据处理:
//   - 去重: URL 精确去重 + 标题 Jaccard 相似度 (≥0.55)
//   - 交叉验证: 同一新闻被 ≥2 个独立渠道报道 → verified=true
//   - 来源标注: 每篇文章标注 source + sourceUrl + sources[] + verifiedBy[]
//   - 源发现: 跟踪新出现的域名，每周报告 ★新增
//   - 渠道情报: 电商/社媒平台情报输出为 channel-report.json
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractArticleContent, loadContentMap, saveContentMap } from './article-extractor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'articles.json');
const CHANNEL_REPORT_PATH = join(__dirname, '..', 'src', 'data', 'channel-report.json');
const SOURCE_REGISTRY_PATH = join(__dirname, '..', 'src', 'data', 'source-registry.json');
const CONTENT_PATH = join(__dirname, '..', 'src', 'data', 'content.js');

// ============================================================
// 配置
// ============================================================

const SEARCH_KEYWORDS = [
  '保定冰柿', '磨盘柿 冰柿', '保定柿子 冰柿',
  '易县冰柿', '保定冻柿 磨盘柿', '保定冰激凌柿子',
];

const SIMILARITY_THRESHOLD = 0.55;
const REQUEST_TIMEOUT = 15000;
const INTER_REQUEST_DELAY = 800;

const RELATED_KEYWORDS = [
  '冰柿', '磨盘柿', '保定柿', '柿子', '冰激凌柿子',
  '柿产业', '冻柿', '易县', '独乐', '柿柿如意',
];

// 多媒体平台检索配置
const MULTIMEDIA_PLATFORMS = [
  { name: '淘宝', query: '保定冰柿 site:taobao.com', engine: 'bing' },
  { name: '京东', query: '保定冰柿 site:jd.com', engine: 'bing' },
  { name: '拼多多', query: '保定冰柿 拼多多', engine: 'bing' },
  { name: '1688', query: '保定冰柿 site:1688.com', engine: 'bing' },
  { name: '抖音', query: '保定冰柿 抖音 直播', engine: 'bing' },
  { name: '快手', query: '保定冰柿 快手', engine: 'bing' },
  { name: '小红书', query: '保定冰柿 小红书 种草', engine: 'bing' },
  { name: '视频号', query: '保定冰柿 视频号', engine: 'bing' },
  { name: '盒马鲜生', query: '保定冰柿 盒马鲜生 购买', engine: 'bing' },
];

// 政府网站汇总检索
const GOV_SITE_QUERIES = [
  '保定冰柿 site:gov.cn',
  '保定冰柿 site:hebei.gov.cn',
  '保定冰柿 site:bd.gov.cn',
  '冰柿 产业 site:gov.cn',
];

// 行业网站汇总检索
const INDUSTRY_SITE_QUERIES = [
  '保定冰柿 果品 产业',
  '保定冰柿 食品 加工',
  '保定冰柿 农产品 出口',
  '冰柿 冷链 物流',
  '磨盘柿 产业链',
];

// 已知权威来源域名 (用于自动分类)
const AUTHORITATIVE_DOMAINS = [
  'gov.cn', 'hebei.gov.cn', 'bd.gov.cn', 'people.com.cn',
  'xinhuanet.com', 'cctv.com', 'chinanews.com', 'hebnews.cn',
  'bdnews.cn', 'china.com.cn', 'gmw.cn', 'youth.cn',
];

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function titleSimilarity(a, b) {
  if (a === b) return 1.0;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a), setB = bigrams(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function isRelatedToBingShi(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  return RELATED_KEYWORDS.some(k => text.includes(k));
}

function slugify(str) {
  let s = str.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return s.slice(0, 80) || 'article-' + Date.now();
}

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  try { return new Date(dateStr).toISOString().slice(0, 10); }
  catch { return new Date().toISOString().slice(0, 10); }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return '网络'; }
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function escapeTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

async function fillArticleContent(article) {
  const { map } = loadContentMap();
  if (map[article.slug]) return;
  const content = await extractArticleContent(article.sourceUrl);
  if (content) {
    map[article.slug] = content;
    saveContentMap(map);
    console.log(`  [Content] 已抓取正文: ${article.title.slice(0, 30)}`);
  } else {
    const fallback = `<p>${escapeTemplate(article.summary || article.title)}</p><p>（原文来源：${article.source}）</p>`;
    map[article.slug] = fallback;
    saveContentMap(map);
    console.log(`  [Content] 使用摘要 fallback: ${article.title.slice(0, 30)}`);
  }
}

function extractRealUrl(url) {
  try {
    if (url.startsWith('/link?') || url.startsWith('http')) {
      const u = new URL(url, 'https://www.baidu.com');
      const real = u.searchParams.get('url');
      if (real) return decodeURIComponent(real);
    }
  } catch {}
  return url;
}

function extractDateFromSource(url, fallback) {
  try {
    const realUrl = extractRealUrl(url);
    // 模式1: /2026/07/17
    const m1 = realUrl.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\b/);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    // 模式2: -20260717- 或 _20260717_ 或 20260717
    const m2 = realUrl.match(/[-_]?(20\d{2})(\d{2})(\d{2})[-_]?/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  } catch {}
  return fallback || null;
}

function isAuthoritativeSource(domain) {
  return AUTHORITATIVE_DOMAINS.some(d => domain.includes(d));
}

// ============================================================
// 采集源 1: Bing News RSS
// ============================================================

async function fetchFromBingNews(keyword) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&mkt=zh-CN`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; icyshi-bot/3.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const itemRegex = /<item>[\s\S]*?<\/item>/g;
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const itemHtml = match[0];
      const title = stripHtml((/<title>(.*?)<\/title>/.exec(itemHtml))?.[1] || '');
      const rawLink = (/<link>(.*?)<\/link>/.exec(itemHtml))?.[1] || '';
      const desc = stripHtml((/<description>(.*?)<\/description>/.exec(itemHtml))?.[1] || '');
      const dateStr = (/<pubDate>(.*?)<\/pubDate>/.exec(itemHtml))?.[1] || '';
      const sourceName = stripHtml((/<source[^>]*>(.*?)<\/source>/.exec(itemHtml))?.[1] || '');
      const link = extractRealUrl(rawLink);
      if (title && link) {
        items.push({ title, url: link, summary: desc.slice(0, 200), date: parseDate(dateStr), sourceName: sourceName || extractDomain(link), fetchSource: 'Bing News' });
      }
    }
    return items;
  } catch (e) { console.log(`  [Bing News] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 2: Google News RSS
// ============================================================

async function fetchFromGoogleNews(keyword) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; icyshi-bot/3.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const itemRegex = /<item>[\s\S]*?<\/item>/g;
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const itemHtml = match[0];
      const title = stripHtml((/<title>(.*?)<\/title>/.exec(itemHtml))?.[1] || '');
      const rawLink = (/<link>(.*?)<\/link>/.exec(itemHtml))?.[1] || '';
      const desc = stripHtml((/<description>(.*?)<\/description>/.exec(itemHtml))?.[1] || '');
      const dateStr = (/<pubDate>(.*?)<\/pubDate>/.exec(itemHtml))?.[1] || '';
      const sourceName = stripHtml((/<source[^>]*>(.*?)<\/source>/.exec(itemHtml))?.[1] || '');
      const link = extractRealUrl(rawLink);
      if (title && link) {
        items.push({ title, url: link, summary: desc.slice(0, 200), date: parseDate(dateStr), sourceName: sourceName || extractDomain(link), fetchSource: 'Google News' });
      }
    }
    return items;
  } catch (e) { console.log(`  [Google News] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 3: Baidu News (HTML 抓取 — 解析 s-data 注释)
// ============================================================

async function fetchFromBaiduNews(keyword) {
  const url = `https://www.baidu.com/s?tn=news&rtt=1&bsst=1&wd=${encodeURIComponent(keyword)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const items = [];
    const sdataRegex = /<!--s-data:(\{[\s\S]*?\})-->/g;
    let match;
    const seen = new Set();
    while ((match = sdataRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        const title = stripHtml(data.title || '');
        const titleUrl = data.titleUrl || '';
        if (title && titleUrl && !seen.has(titleUrl)) {
          seen.add(titleUrl);
          items.push({
            title,
            url: titleUrl,
            summary: stripHtml(data.content || data.abstract || '').slice(0, 200),
            date: data.publishTime || new Date().toISOString().slice(0, 10),
            sourceName: data.authorName || data.siteName || extractDomain(titleUrl),
            fetchSource: 'Baidu News',
          });
        }
      } catch { /* JSON parse error, skip */ }
    }
    return items.slice(0, 20);
  } catch (e) { console.log(`  [Baidu News] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 4: Sogou News (HTML 抓取)
// ============================================================

async function fetchFromSogouNews(keyword) {
  const url = `https://news.sogou.com/news?query=${encodeURIComponent(keyword)}&sort=1`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const linkPattern = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = linkPattern.exec(html)) !== null) {
      const rawUrl = match[1], title = stripHtml(match[2]);
      if (title && title.length > 10 && rawUrl && !rawUrl.includes('sogou.com') && !rawUrl.includes('sogoucdn.com') && !seen.has(rawUrl)) {
        seen.add(rawUrl);
        items.push({ title, url: rawUrl, summary: '', date: new Date().toISOString().slice(0, 10), sourceName: extractDomain(rawUrl), fetchSource: 'Sogou News' });
      }
    }
    return items.slice(0, 20);
  } catch (e) { console.log(`  [Sogou News] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 5: 360 News (HTML 抓取) ★新增
// ============================================================

async function fetchFrom360News(keyword) {
  const url = `https://news.so.com/ns?q=${encodeURIComponent(keyword)}&src=tab_www`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const seen = new Set();

    // 360新闻搜索结果结构: 标题在 <a> 标签中
    const linkRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const rawUrl = match[1], title = stripHtml(match[2]);
      if (title && title.length > 10 && rawUrl && !rawUrl.includes('so.com') && !seen.has(rawUrl)) {
        seen.add(rawUrl);
        items.push({ title, url: rawUrl, summary: '', date: new Date().toISOString().slice(0, 10), sourceName: extractDomain(rawUrl), fetchSource: '360 News' });
      }
    }
    // Fallback: 通用链接提取
    if (items.length === 0) {
      const fallbackRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = fallbackRegex.exec(html)) !== null) {
        const rawUrl = match[1], title = stripHtml(match[2]);
        if (title && title.length > 10 && rawUrl && !rawUrl.includes('so.com') && !seen.has(rawUrl)) {
          seen.add(rawUrl);
          items.push({ title, url: rawUrl, summary: '', date: new Date().toISOString().slice(0, 10), sourceName: extractDomain(rawUrl), fetchSource: '360 News' });
        }
      }
    }
    return items.slice(0, 20);
  } catch (e) { console.log(`  [360 News] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 6: 政府网站聚合 (via Bing) ★新增
// ============================================================

async function fetchFromGovSites() {
  const allItems = [];
  for (const query of GOV_SITE_QUERIES) {
    await sleep(INTER_REQUEST_DELAY);
    const items = await fetchFromBingSearch(query);
    for (const item of items) {
      item.fetchSource = 'Gov Sites';
      allItems.push(item);
    }
  }
  console.log(`  [Gov Sites] 共 ${allItems.length} 条`);
  return allItems;
}

// ============================================================
// 采集源 7: 行业网站聚合 (via Bing) ★新增
// ============================================================

async function fetchFromIndustrySites() {
  const allItems = [];
  for (const query of INDUSTRY_SITE_QUERIES) {
    await sleep(INTER_REQUEST_DELAY);
    const items = await fetchFromBingSearch(query);
    for (const item of items) {
      item.fetchSource = 'Industry Sites';
      allItems.push(item);
    }
  }
  console.log(`  [Industry Sites] 共 ${allItems.length} 条`);
  return allItems;
}

// ============================================================
// 采集源 8: 百度资讯 (news.baidu.com) ★新增
// ============================================================

async function fetchFromBaiduZixun(keyword) {
  const url = `https://news.baidu.com/ns?word=${encodeURIComponent(keyword)}&pn=0&rn=20&cl=2&ct=1&tn=news&ie=utf-8`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const seen = new Set();

    // 百度资讯页面结构: 标题在 <h3> 中的 <a> 标签
    const h3Regex = /<h3[^>]*class="[^"]*news-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = h3Regex.exec(html)) !== null) {
      const rawUrl = match[1], title = stripHtml(match[2]);
      if (title && title.length > 8 && rawUrl && !seen.has(rawUrl)) {
        seen.add(rawUrl);
        items.push({ title, url: rawUrl, summary: '', date: new Date().toISOString().slice(0, 10), sourceName: extractDomain(rawUrl), fetchSource: 'Baidu Zixun' });
      }
    }
    return items.slice(0, 20);
  } catch (e) { console.log(`  [Baidu Zixun] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 采集源 9: 搜狗微信搜索 (公众号文章)
// ============================================================

async function fetchFromWeixinSogou(keyword) {
  const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(keyword)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const items = [];
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = itemRegex.exec(html)) !== null) {
      const rawUrl = match[1], title = stripHtml(match[2]);
      if (title && title.length > 5 && rawUrl && !seen.has(rawUrl)) {
        seen.add(rawUrl);
        items.push({ title, url: rawUrl, summary: '', date: new Date().toISOString().slice(0, 10), sourceName: '微信公众号', fetchSource: 'WeChat Sogou' });
      }
    }
    return items.slice(0, 15);
  } catch (e) { console.log(`  [WeChat] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 通用搜索: Bing 搜索
// ============================================================

async function fetchFromBingSearch(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-cn&count=10`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok && resp.status !== 302) return [];
    const html = await resp.text();
    const items = [];
    const resultRegex = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    const seen = new Set();
    while ((match = resultRegex.exec(html)) !== null) {
      const rawUrl = match[1], title = stripHtml(match[2]), snippet = stripHtml(match[3] || '');
      if (title && rawUrl && !seen.has(rawUrl) && rawUrl.startsWith('http')) {
        seen.add(rawUrl);
        items.push({ title, url: rawUrl, summary: snippet.slice(0, 200), date: new Date().toISOString().slice(0, 10), sourceName: extractDomain(rawUrl), fetchSource: 'Bing Search' });
      }
    }
    return items.slice(0, 10);
  } catch (e) { console.log(`  [Bing Search] ⚠ ${e.message}`); return []; }
}

// ============================================================
// 渠道情报采集
// ============================================================

async function fetchChannelIntel() {
  const report = {
    fetchedAt: new Date().toISOString(),
    platforms: [],
  };

  console.log('\n[Channels] 多媒体平台渠道情报');
  console.log('─────────────────────────────────────');

  for (const platform of MULTIMEDIA_PLATFORMS) {
    await sleep(INTER_REQUEST_DELAY);
    console.log(`  [${platform.name}] 检索中...`);
    const results = await fetchFromBingSearch(platform.query);

    const relevant = results.filter(r => isRelatedToBingShi(r.title, r.summary));

    report.platforms.push({
      platform: platform.name,
      query: platform.query,
      totalResults: results.length,
      relevantResults: relevant.length,
      findings: relevant.slice(0, 5).map(r => ({
        title: r.title,
        url: r.url,
        source: r.sourceName,
        snippet: r.summary,
      })),
    });

    console.log(`  [${platform.name}] 共 ${results.length} 条，相关 ${relevant.length} 条`);
  }

  return report;
}

// ============================================================
// 源发现机制 ★新增
// ============================================================

function discoverNewSources(allRawItems, existingArticles) {
  // 收集所有已知域名
  const knownDomains = new Set();
  for (const a of existingArticles) {
    try { knownDomains.add(new URL(a.sourceUrl).hostname.replace('www.', '')); } catch {}
  }

  // 统计当前采集到的新域名
  const newDomains = new Map();
  for (const item of allRawItems) {
    try {
      const domain = new URL(item.url).hostname.replace('www.', '');
      if (!knownDomains.has(domain)) {
        newDomains.set(domain, (newDomains.get(domain) || 0) + 1);
      }
    } catch {}
  }

  // 更新源注册表
  let sourceRegistry = { domains: {}, lastUpdated: null };
  try {
    sourceRegistry = JSON.parse(readFileSync(SOURCE_REGISTRY_PATH, 'utf-8'));
  } catch {}

  sourceRegistry.lastUpdated = new Date().toISOString();
  for (const [domain, count] of newDomains) {
    if (!sourceRegistry.domains[domain]) {
      sourceRegistry.domains[domain] = { firstSeen: new Date().toISOString(), count: 0, authoritative: isAuthoritativeSource(domain) };
    }
    sourceRegistry.domains[domain].count += count;
    sourceRegistry.domains[domain].lastSeen = new Date().toISOString();
  }

  writeFileSync(SOURCE_REGISTRY_PATH, JSON.stringify(sourceRegistry, null, 2), 'utf-8');

  // 报告
  if (newDomains.size > 0) {
    console.log(`\n[Discovery] 发现 ${newDomains.size} 个新域名:`);
    const sorted = [...newDomains.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 10)) {
      const auth = isAuthoritativeSource(domain) ? ' 🏛️权威' : '';
      console.log(`  · ${domain} (${count}条)${auth}`);
    }
  }

  // 统计权威源覆盖率
  const totalDomains = Object.keys(sourceRegistry.domains).length;
  const authDomains = Object.values(sourceRegistry.domains).filter(d => d.authoritative).length;
  if (totalDomains > 0) {
    console.log(`\n[Discovery] 源注册表: ${totalDomains} 个域名 (${authDomains} 个权威源)`);
  }

  return sourceRegistry;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  🦐 icyshi.com 全平台情报采集 v3');
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log('  渠道: 8 新闻 + 9 电商社媒 + 1 新零售 = 18 渠道');
  console.log('═══════════════════════════════════════════\n');

  // 1. 加载现有文章
  const existing = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
  const existingSlugs = new Set(existing.map(a => a.slug));
  const existingUrls = new Set(existing.map(a => a.sourceUrl).filter(Boolean));
  console.log(`[Load] 现有文章: ${existing.length} 篇\n`);

  // 2. 新闻采集 (8 个渠道)
  const allRawItems = [];

  const newsSources = [
    { name: 'Bing News', fn: fetchFromBingNews, type: 'RSS' },
    { name: 'Google News', fn: fetchFromGoogleNews, type: 'RSS' },
    { name: 'Baidu News', fn: fetchFromBaiduNews, type: '抓取' },
    { name: 'Sogou News', fn: fetchFromSogouNews, type: '抓取' },
    { name: '360 News', fn: fetchFrom360News, type: '抓取' },
    { name: 'Baidu Zixun', fn: fetchFromBaiduZixun, type: '抓取' },
  ];

  console.log('═ 新闻采集 (6 渠道) ═');
  for (const source of newsSources) {
    console.log(`[${source.name}] (${source.type})`);
    for (const keyword of SEARCH_KEYWORDS) {
      await sleep(INTER_REQUEST_DELAY);
      const items = await source.fn(keyword);
      for (const item of items) allRawItems.push(item);
      if (items.length > 0) console.log(`  → "${keyword}": ${items.length} 条`);
    }
  }

  // 3. 政府网站聚合
  console.log('\n[Gov Sites] 政府网站聚合');
  const govItems = await fetchFromGovSites();
  for (const item of govItems) allRawItems.push(item);

  // 4. 行业网站聚合
  console.log('\n[Industry Sites] 行业网站聚合');
  const industryItems = await fetchFromIndustrySites();
  for (const item of industryItems) allRawItems.push(item);

  // 5. 公众号采集
  console.log('\n[WeChat] 搜狗微信搜索 (公众号)');
  for (const keyword of SEARCH_KEYWORDS.slice(0, 4)) {
    await sleep(INTER_REQUEST_DELAY);
    const items = await fetchFromWeixinSogou(keyword);
    for (const item of items) allRawItems.push(item);
    if (items.length > 0) console.log(`  → "${keyword}": ${items.length} 条`);
  }

  console.log(`\n[Stats] 原始采集: ${allRawItems.length} 条 (含重复)\n`);

  // 6. 源发现
  const sourceRegistry = discoverNewSources(allRawItems, existing);

  // 7. 渠道情报
  let channelReport = null;
  try {
    channelReport = await fetchChannelIntel();
    writeFileSync(CHANNEL_REPORT_PATH, JSON.stringify(channelReport, null, 2), 'utf-8');
    console.log(`\n[Channels] 渠道情报已保存: ${CHANNEL_REPORT_PATH}`);
  } catch (e) {
    console.log(`\n[Channels] ⚠ 渠道情报采集失败: ${e.message}`);
  }

  // 8. 过滤 + 去重 (按 URL)
  const seenUrls = new Set();
  const uniqueByUrl = [];
  for (const item of allRawItems) {
    if (!seenUrls.has(item.url) && !existingUrls.has(item.url)) {
      seenUrls.add(item.url);
      uniqueByUrl.push(item);
    }
  }
  console.log(`[Dedup] URL 去重后: ${uniqueByUrl.length} 条`);

  // 9. 标题相似度去重 + 交叉验证分组
  const groups = [];
  for (const item of uniqueByUrl) {
    let matchedGroup = null;
    for (const group of groups) {
      for (const gItem of group.items) {
        if (titleSimilarity(item.title, gItem.title) >= SIMILARITY_THRESHOLD) {
          matchedGroup = group; break;
        }
      }
      if (matchedGroup) break;
    }
    if (matchedGroup) { matchedGroup.items.push(item); }
    else { groups.push({ items: [item] }); }
  }
  console.log(`[Dedup] 标题相似度分组后: ${groups.length} 组\n`);

  // 10. 生成最终文章
  const newArticles = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const group of groups) {
    const items = group.items;
    const bestItem = items.reduce((best, cur) => cur.title.length > best.title.length ? cur : best, items[0]);
    let bestDate = items.map(i => i.date).sort()[0] || today;
    // 如果日期仍是今天，尝试从 sourceUrl 提取真实日期
    if (bestDate === today) {
      const urlDate = extractDateFromSource(bestItem.url, null);
      if (urlDate) bestDate = urlDate;
    }
    const summaries = items.map(i => i.summary).filter(Boolean);
    const bestSummary = summaries[0] || '';
    const itemWithSource = items.find(i => i.sourceName && i.sourceName !== '网络') || bestItem;
    const mainSource = itemWithSource.sourceName || extractDomain(bestItem.url);
    const mainSourceUrl = bestItem.url;

    const allSources = items.map(i => ({ name: i.sourceName || extractDomain(i.url), url: i.url }));
    const uniqueSources = [];
    const seenSourceNames = new Set();
    for (const s of allSources) {
      if (!seenSourceNames.has(s.name)) { seenSourceNames.add(s.name); uniqueSources.push(s); }
    }

    const verified = uniqueSources.length >= 2;
    const verifiedBy = verified ? uniqueSources.map(s => s.name) : [];
    const fetchChannels = [...new Set(items.map(i => i.fetchSource))];
    const slug = slugify(bestItem.url);

    // 自动分类: 权威源标记为高质量
    const isAuth = isAuthoritativeSource(extractDomain(bestItem.url));
    const tag = isAuth ? '权威来源' : '自动采集';

    if (!existingSlugs.has(slug) && isRelatedToBingShi(bestItem.title, bestSummary)) {
      newArticles.push({
        slug, title: bestItem.title, date: bestDate, category: 'news', tag,
        summary: bestSummary || bestItem.title, source: mainSource, sourceUrl: mainSourceUrl,
        sources: uniqueSources, verified, verifiedBy, fetchChannels, fetchedAt: new Date().toISOString(),
      });
      existingSlugs.add(slug);
    }
  }

  // 11. 输出新闻结果
  if (newArticles.length === 0) {
    console.log('[Result] 无新文章');
  } else {
    console.log(`[Result] 新增 ${newArticles.length} 篇:\n`);
    for (const a of newArticles) {
      const verifiedBadge = a.verified ? ' ✅交叉验证' : '';
      const authBadge = a.tag === '权威来源' ? ' 🏛️' : '';
      const fetchBadge = a.fetchChannels ? ` [${a.fetchChannels.join(', ')}]` : '';
      console.log(`  + ${a.date}  ${a.title}${authBadge}`);
      console.log(`    来源: ${a.source}${verifiedBadge}${fetchBadge}`);
      if (a.verified) console.log(`    验证: ${a.verifiedBy.join(' · ')}`);
      console.log();
    }
    existing.push(...newArticles);
    existing.sort((a, b) => b.date.localeCompare(a.date));
    writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2), 'utf-8');
    console.log(`[Save] 总计 ${existing.length} 篇文章已保存`);
  }

  // 12. 抓取/补齐新文章正文
  console.log(`\n[Content] 开始抓取/补齐 ${newArticles.length} 篇正文`);
  for (const article of newArticles) {
    await fillArticleContent(article);
    await sleep(INTER_REQUEST_DELAY);
  }

  // 13. 渠道情报摘要
  if (channelReport) {
    console.log('\n═ 多媒体渠道情报摘要 ═');
    for (const p of channelReport.platforms) {
      const icon = p.relevantResults > 0 ? '📡' : '⚪';
      console.log(`  ${icon} ${p.platform}: ${p.relevantResults} 条相关情报`);
    }
    console.log(`\n  详情: ${CHANNEL_REPORT_PATH}`);
  }

  console.log(`\n  源注册表: ${SOURCE_REGISTRY_PATH}`);
  console.log('\n═══════════════════════════════════════════\n');
}

main().catch(console.error);