export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    try {
      const body = await request.json();
      const { image, mimeType, engine } = body;

      if (!image || typeof image !== 'string') {
        return new Response(JSON.stringify({ books: [], error: 'Missing image' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      let mime = mimeType || 'image/jpeg';
      if (image.startsWith('/9j/')) mime = 'image/jpeg';
      else if (image.startsWith('iVBOR')) mime = 'image/png';
      else if (image.startsWith('R0lGO')) mime = 'image/gif';
      else if (image.startsWith('UklGR')) mime = 'image/webp';

      // מנוע Llama 3.2 Vision - דרך Cloudflare Workers AI (חינמי לחלוטין)
      if (engine === 'llama') {
        return await runLlama(image, mime, env);
      }

      // ברירת מחדל: Gemini
      return await runGemini(image, mime, env);

    } catch(err) {
      return new Response(JSON.stringify({ error: err.message, books: [] }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}

// ===== Gemini =====
async function runGemini(image, mime, env) {
  const prompt = `אתה מומחה לזיהוי ספרים עבריים. בתמונה זו יש גבות ספרים בספריה.

המשימה: זהה את כל הספרים העבריים הנראים בתמונה.

הנחיות:
- זהה ספרים לפי הטקסט הנראה על גב הספר או הכריכה
- אם הטקסט חלקי או לא ברור - השתמש בידע שלך כדי להשלים את שם הספר
- כתוב את שם הספר בעברית מלאה ומתוקנת
- כתוב את שם המחבר אם נראה או ידוע
- התעלם מספרים באנגלית או בשפות אחרות
- החזר כמה שיותר ספרים עבריים

החזר JSON בלבד, ללא טקסט נוסף:
{"books":[{"title":"שם הספר","author":"שם המחבר","conf":85}]}
אם אין ספרים עבריים: {"books":[]}`;

  const keys = [env.GEMINI_KEY, env.GEMINI_KEY2, env.GEMINI_KEY3].filter(Boolean);
  if (keys.length === 0) {
    return new Response(JSON.stringify({ books: [], error: 'No API keys configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const models = ['gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17'];
  let books = [];
  let lastError = null;

  outer:
  for (const model of models) {
    for (const key of keys) {
      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: mime, data: image } },
                { text: prompt }
              ]}],
              generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' }
            })
          }
        );
      } catch(fetchErr) { lastError = fetchErr.message; continue; }

      const data = await res.json();

      if (data.promptFeedback?.blockReason) { lastError = `Blocked: ${data.promptFeedback.blockReason}`; break outer; }

      if (data.error) {
        lastError = data.error.message;
        const isQuota = ['quota','RESOURCE_EXHAUSTED','RATE_LIMIT_EXCEEDED','high demand','overloaded']
          .some(s => data.error.message.includes(s));
        continue;
      }

      if (!data.candidates?.length) { lastError = 'Empty candidates'; continue; }

      const parts = data.candidates[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (!text) { lastError = 'Empty response'; continue; }

      let parsed = [];
      try {
        const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        const m = clean.match(/\{[\s\S]*"books"[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]).books || [];
      } catch(e) {
        try {
          const m = text.match(/"books"\s*:\s*(\[[\s\S]*?\])/);
          if (m) parsed = JSON.parse(m[1]);
        } catch(e2) { lastError = 'JSON parse error'; continue; }
      }

      if (parsed.length > 0) { books = parsed; break outer; }
      lastError = 'No books detected by ' + model;
    }
  }

  return new Response(JSON.stringify({ books, error: books.length === 0 ? lastError : null }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ===== Llama 3.2 Vision (Cloudflare Workers AI - חינמי) =====
async function runLlama(image, mime, env) {
  try {
    if (!env.AI) {
      return new Response(JSON.stringify({ books: [], error: 'Cloudflare AI binding not configured' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const prompt = `You are an expert at reading Hebrew book spines. Look at this image and identify all Hebrew books visible.

For each Hebrew book, extract the title and author from the spine text.
If text is partially visible, use your knowledge to complete the title.

Return ONLY a JSON object in this exact format:
{"books":[{"title":"שם הספר בעברית","author":"שם המחבר","conf":80}]}
If no Hebrew books visible: {"books":[]}`;

    // המר base64 ל-Uint8Array
    const binaryStr = atob(image);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: Array.from(bytes) },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: 1024,
    });

    const text = response?.response || '';
    let books = [];
    try {
      const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const m = clean.match(/\{[\s\S]*"books"[\s\S]*\}/);
      if (m) books = JSON.parse(m[0]).books || [];
    } catch(e) {
      try {
        const m = text.match(/"books"\s*:\s*(\[[\s\S]*?\])/);
        if (m) books = JSON.parse(m[1]);
      } catch(e2) {}
    }

    return new Response(JSON.stringify({ books, error: books.length === 0 ? 'Llama: no books' : null }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch(err) {
    return new Response(JSON.stringify({ books: [], error: 'Llama error: ' + err.message }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
