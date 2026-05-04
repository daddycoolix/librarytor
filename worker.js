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

      if (engine === 'llama') return await runLlama(image, mime, env);
      return await runGemini(image, mime, env);

    } catch(err) {
      return new Response(JSON.stringify({ error: err.message, books: [] }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const isQuotaError = msg =>
  ['quota', 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 'high demand', 'overloaded']
    .some(s => msg.includes(s));

async function callGemini(model, key, mime, image, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mime, data: image } },
          { text: prompt }
        ]}],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    }
  );
  return await res.json();
}

function parseBooks(text) {
  try {
    const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const m = clean.match(/\{[\s\S]*"books"[\s\S]*\}/);
    if (m) return JSON.parse(m[0]).books || [];
  } catch(e) {}
  try {
    const m = text.match(/"books"\s*:\s*(\[[\s\S]*?\])/);
    if (m) return JSON.parse(m[1]);
  } catch(e) {}
  return null; // parse failed
}

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

החזר JSON בלבד:
{"books":[{"title":"שם הספר","author":"שם המחבר","conf":85}]}
אם אין ספרים עבריים: {"books":[]}`;

  const keys = [env.GEMINI_KEY, env.GEMINI_KEY2, env.GEMINI_KEY3].filter(Boolean);
  if (!keys.length) {
    return new Response(JSON.stringify({ books: [], error: 'No API keys' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // נסה כל key × כל model, עם retry על quota
  const models = ['gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17'];
  let books = [];
  let lastError = null;
  let quotaCount = 0;

  for (const model of models) {
    for (const key of keys) {
      let data;
      try {
        data = await callGemini(model, key, mime, image, prompt);
      } catch(e) {
        lastError = e.message;
        continue;
      }

      if (data.promptFeedback?.blockReason) {
        lastError = `Blocked: ${data.promptFeedback.blockReason}`;
        goto_next_model: break;
      }

      if (data.error) {
        lastError = data.error.message;
        if (isQuotaError(lastError)) {
          quotaCount++;
          // אם כל ה-keys עמוסים - המתן קצת לפני model הבא
          if (quotaCount % keys.length === 0) await sleep(800);
          continue;
        }
        continue; // שגיאה אחרת - נסה key הבא
      }

      if (!data.candidates?.length) { lastError = 'Empty candidates'; continue; }

      const parts = data.candidates[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (!text) { lastError = 'Empty text'; continue; }

      const parsed = parseBooks(text);
      if (parsed === null) { lastError = 'Parse failed'; continue; }
      if (parsed.length > 0) { books = parsed; break; }

      // Gemini ענה אבל החזיר [] - ספרים לא נמצאו בחלק זה
      lastError = `No books (${model})`;
      break; // אין טעם לנסות keys נוספים על אותו חלק
    }
    if (books.length > 0) break;
  }

  return new Response(JSON.stringify({
    books,
    error: books.length === 0 ? lastError : null
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function runLlama(image, mime, env) {
  try {
    if (!env.AI) return new Response(
      JSON.stringify({ books: [], error: 'AI binding not configured' }),
      { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );

    const prompt = `You are an expert at reading Hebrew book spines. Identify all Hebrew books visible.
Return ONLY JSON: {"books":[{"title":"שם בעברית","author":"מחבר","conf":80}]}
If no Hebrew books: {"books":[]}`;

    const binaryStr = atob(image);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [{ role: 'user', content: [
        { type: 'image', image: Array.from(bytes) },
        { type: 'text', text: prompt }
      ]}],
      max_tokens: 1024,
    });

    const text = response?.response || '';
    const books = parseBooks(text) || [];
    return new Response(JSON.stringify({ books, error: books.length === 0 ? 'Llama: no books' : null }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch(err) {
    return new Response(JSON.stringify({ books: [], error: 'Llama: ' + err.message }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
