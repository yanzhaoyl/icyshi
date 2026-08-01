// ============================================================
// 保定冰柿全平台情报采集器 for icyshi.com
// 用法: node scripts/fetch-news.mjs
// GitHub Actions 每天自动运行
// ============================================================
//
// 新闻渠道 (4 个):
//   1. Bing News RSS        — 微软新闻聚合
//   2. Google News RSS      — 全球新闻聚合
//   3. Baidu News (HTML)    — 国内最大新闻聚合
//   4. Sogou News (HTML)    — 搜狗新闻搜索
//
// 多媒体平台情报 (8 个):
//   5. 淘宝 (taobao.com)    — 通过搜索引擎索引检索
//   6. 京东 (jd.com)        — 通过搜索引擎索引检索
//   7. 拼多多 (pdd)         — 通过搜索引擎索引检索
//   8. 抖音                 — 通过搜索引擎索引检索
//   9. 快手                 — 通过搜索引擎索引检索
//  10. 小红书               — 通过搜索引擎索引检索
//  11. 视频号               — 通过搜索引擎索引检索
//  12. 公众号 (weixin.sogou.com) — 搜狗微信搜索
//
// 13. 盒马鲜生              — 新零售渠道情报
//
// 数据处理:
//   - 去重: URL 精确去重 + 标题 Jaccard 相似度 (≥0.55)
//   - 交叉验证: 同一新闻被 ≥2 个独立渠道报道 → verified=true
//   - 来源标注: 每篇文章标注 source + sourceUrl + sources[] + verifiedBy[]
//   - 渠道情报: 电商/社媒平台情报输出为 channel-report.json
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'articles.json');
const CHANNEL_REPORT_PATH = join(__dirname, '..', 'src', 'data', 'channel-report.json');

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
  { name: '抖音', query: '保定冰柿 抖音 直播', engine: 'bing' },
  { name: '快手', query: '保定冰柿 快手', engine: 'bing' },
  { name: '小红书', query: '保定冰柿 小红书 种草', engine: 'bing' },
  { name: '视频号', query: '保定冰柿 视频号', engine: 'bing' },
  { name: '盒马鲜生', query: '保定冰柿 盒马鲜生 购买', engine: 'bing' },
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

function extractRealUrl(url) {
  const baiduMatch = url.match(/[?&]url=([^&]+)/);
  if (baiduMatch) { try { return decodeURIComponent(baiduMatch[1]); } catch {} }
  return url;
}

// ============================================================
// 采集源 1: Bing News RSS
// ============================================================

async function fetchFromBingNews(keyword) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(keyword)}&format=rss&mkt=zh-CN`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; icyshi-bot/2.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; icyshi-bot/2.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
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
    // 百度新闻在 <!--s-data: 注释中嵌入 JSON
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
// 采集源 5: 搜狗微信搜索 (公众号文章)
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
    // 搜狗微信搜索结果: 解析标题和链接
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
// 采集源 6: Bing 通用搜索 (用于多媒体平台情报)
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
    // Bing 搜索结果: 解析搜索结果条目
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
// 采集源 7: 多媒体平台渠道情报
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
// 主流程
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  🦐 icyshi.com 全平台情报采集');
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════\n');

  // 1. 加载现有文章
  const existing = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
  const existingSlugs = new Set(existing.map(a => a.slug));
  const existingUrls = new Set(existing.map(a => a.sourceUrl).filter(Boolean));
  console.log(`[Load] 现有文章: ${existing.length} 篇\n`);

  // 2. 新闻采集 (4 个渠道)
  const allRawItems = [];

  const newsSources = [
    { name: 'Bing News', fn: fetchFromBingNews, type: 'RSS' },
    { name: 'Google News', fn: fetchFromGoogleNews, type: 'RSS' },
    { name: 'Baidu News', fn: fetchFromBaiduNews, type: '抓取' },
    { name: 'Sogou News', fn: fetchFromSogouNews, type: '抓取' },
  ];

  console.log('═ 新闻采集 ═');
  for (const source of newsSources) {
    console.log(`[${source.name}] (${source.type})`);
    for (const keyword of SEARCH_KEYWORDS) {
      await sleep(INTER_REQUEST_DELAY);
      const items = await source.fn(keyword);
      for (const item of items) allRawItems.push(item);
      if (items.length > 0) console.log(`  → "${keyword}": ${items.length} 条`);
    }
  }

  // 3. 公众号采集 (搜狗微信)
  console.log('\n[WeChat] 搜狗微信搜索 (公众号)');
  for (const keyword of SEARCH_KEYWORDS.slice(0, 4)) {
    await sleep(INTER_REQUEST_DELAY);
    const items = await fetchFromWeixinSogou(keyword);
    for (const item of items) allRawItems.push(item);
    if (items.length > 0) console.log(`  → "${keyword}": ${items.length} 条`);
  }

  console.log(`\n[Stats] 原始采集: ${allRawItems.length} 条 (含重复)\n`);

  // 4. 渠道情报
  let channelReport = null;
  try {
    channelReport = await fetchChannelIntel();
    writeFileSync(CHANNEL_REPORT_PATH, JSON.stringify(channelReport, null, 2), 'utf-8');
    console.log(`\n[Channels] 渠道情报已保存: ${CHANNEL_REPORT_PATH}`);
  } catch (e) {
    console.log(`\n[Channels] ⚠ 渠道情报采集失败: ${e.message}`);
  }

  // 5. 过滤 + 去重 (按 URL)
  const seenUrls = new Set();
  const uniqueByUrl = [];
  for (const item of allRawItems) {
    if (!seenUrls.has(item.url) && !existingUrls.has(item.url)) {
      seenUrls.add(item.url);
      uniqueByUrl.push(item);
    }
  }
  console.log(`[Dedup] URL 去重后: ${uniqueByUrl.length} 条`);

  // 6. 标题相似度去重 + 交叉验证分组
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

  // 7. 生成最终文章
  const newArticles = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const group of groups) {
    const items = group.items;
    const bestItem = items.reduce((best, cur) => cur.title.length > best.title.length ? cur : best, items[0]);
    const bestDate = items.map(i => i.date).sort()[0] || today;
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

    if (!existingSlugs.has(slug) && isRelatedToBingShi(bestItem.title, bestSummary)) {
      newArticles.push({
        slug, title: bestItem.title, date: bestDate, category: 'news', tag: '自动采集',
        summary: bestSummary || bestItem.title, source: mainSource, sourceUrl: mainSourceUrl,
        sources: uniqueSources, verified, verifiedBy, fetchChannels, fetchedAt: new Date().toISOString(),
      });
      existingSlugs.add(slug);
    }
  }

  // 8. 输出新闻结果
  if (newArticles.length === 0) {
    console.log('[Result] 无新文章');
  } else {
    console.log(`[Result] 新增 ${newArticles.length} 篇:\n`);
    for (const a of newArticles) {
      const verifiedBadge = a.verified ? ' ✅交叉验证' : '';
      const fetchBadge = a.fetchChannels ? ` [${a.fetchChannels.join(', ')}]` : '';
      console.log(`  + ${a.date}  ${a.title}`);
      console.log(`    来源: ${a.source}${verifiedBadge}${fetchBadge}`);
      if (a.verified) console.log(`    验证: ${a.verifiedBy.join(' · ')}`);
      console.log();
    }
    existing.push(...newArticles);
    existing.sort((a, b) => b.date.localeCompare(a.date));
    writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2), 'utf-8');
    console.log(`[Save] 总计 ${existing.length} 篇文章已保存`);
  }

  // 9. 渠道情报摘要
  if (channelReport) {
    console.log('\n═ 多媒体渠道情报摘要 ═');
    for (const p of channelReport.platforms) {
      const icon = p.relevantResults > 0 ? '📡' : '⚪';
      console.log(`  ${icon} ${p.platform}: ${p.relevantResults} 条相关情报`);
    }
    console.log(`\n  详情: ${CHANNEL_REPORT_PATH}`);
  }

  console.log('\n═══════════════════════════════════════════\n');
}

main().catch(console.error);