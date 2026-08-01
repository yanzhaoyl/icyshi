export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST' }), { status: 405, headers: { 'content-type': 'application/json' } });
  }

  try {
    const { email } = await request.json();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: '请输入有效的邮箱地址' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    const r = await fetch('https://formsubmit.co/ajax/icyshi@foxmail.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: '保定冰柿资讯站 - 新订阅',
        email,
        message: `新订阅邮箱：${email}`,
      }),
    });

    const data = await r.json();

    return new Response(JSON.stringify({
      success: data.success !== false,
      message: data.success ? '订阅成功！' : (data.message || '订阅失败，请稍后重试'),
    }), {
      headers: { 'content-type': 'application/json;charset=utf-8' },
    });
  } catch {
    return new Response(JSON.stringify({ error: '服务器错误' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
