import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractArticleContent, loadContentMap, saveContentMap } from './article-extractor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'src', 'data', 'articles.json');

const articles = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const { map } = loadContentMap();

const missing = articles.filter(a => (a.category === 'news' || a.category === 'enterprise') && !map[a.slug]);
console.log(`[Backfill] 需要补齐正文的文章: ${missing.length} 篇`);

const BATCH = 10;
const toFill = missing.slice(0, BATCH);

for (const article of toFill) {
  const content = await extractArticleContent(article.sourceUrl);
  if (content) {
    map[article.slug] = content;
    console.log(`✅ 已抓取: ${article.title.slice(0, 40)}`);
  } else {
    map[article.slug] = `<p>${article.summary || article.title}</p><p>（原文来源：${article.source}）</p>`;
    console.log(`️ fallback: ${article.title.slice(0, 40)}`);
  }
  saveContentMap(map);
  await new Promise(r => setTimeout(r, 1000));
}

console.log(`[Backfill] 完成 ${toFill.length} 篇`);
