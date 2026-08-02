import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractArticleContent, loadContentMap, saveContentMap } from './article-extractor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'articles.json');

const articles = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const { map } = loadContentMap();

// 找出需要重新提取的文章：正文太短（<200字纯文本）或只有fallback
const needsReExtract = articles.filter(a => {
  if (a.category !== 'news' && a.category !== 'enterprise') return false;
  const content = map[a.slug];
  if (!content) return true;
  const text = content.replace(/<[^>]+>/g, '').trim();
  return text.length < 200 || content.includes('（本文为自动采集摘要') || content.includes('（原文来源：');
});

console.log(`[Backfill] 需要重新提取正文: ${needsReExtract.length} 篇`);

function extractDateFromSource(url) {
  try {
    // Handle encrypted Google News / Baidu links
    if (!url || url.startsWith('/link?') || url.includes('news.google.com/rss')) return null;
    // 模式1: /2026/07/17
    const m1 = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\b/);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    // 模式2: -20260717- 或 _20260717_
    const m2 = url.match(/[-_]?(20\d{2})(\d{2})(\d{2})[-_]?/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  } catch {}
  return null;
}

for (const article of needsReExtract) {
  // 尝试修复日期
  if (article.sourceUrl) {
    const urlDate = extractDateFromSource(article.sourceUrl);
    if (urlDate && article.date !== urlDate) {
      console.log(`  [Date] 修复日期: ${article.date} -> ${urlDate} (${article.title.slice(0, 30)})`);
      article.date = urlDate;
    }
  }

  const content = await extractArticleContent(article.sourceUrl);
  if (content) {
    map[article.slug] = content;
    console.log(`✅ 已重新提取: ${article.title.slice(0, 40)}`);
  } else {
    // 更好的 fallback
    const fallback = `<p>${article.summary || article.title}</p><p style="color:#999;font-size:0.9rem;">（本文为自动采集摘要，点击原文链接查看完整内容）</p>`;
    map[article.slug] = fallback;
    console.log(`️ fallback: ${article.title.slice(0, 40)}`);
  }
  saveContentMap(map);
  await new Promise(r => setTimeout(r, 1000));
}

// 保存修复后的 dates
writeFileSync(DATA_PATH, JSON.stringify(articles, null, 2), 'utf-8');

console.log(`[Backfill] 完成 ${needsReExtract.length} 篇`);