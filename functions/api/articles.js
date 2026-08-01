import articles from './articles.json' assert { type: 'json' };

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const q = url.searchParams.get('q')?.toLowerCase();

  let results = articles;

  if (category) {
    results = results.filter(a => a.category === category);
  }
  if (q) {
    results = results.filter(a => (a.title && a.title.toLowerCase().includes(q)) || (a.summary && a.summary.toLowerCase().includes(q)));
  }

  return new Response(JSON.stringify({ articles: results, total: results.length }), {
    headers: { 'content-type': 'application/json;charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
