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
          temperature: 0,
          maxOutputTokens: 4096,
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
  return null;
}

async function runGemini(image, mime, env) {
  const prompt = `אתה מומחה לזיהוי ספרים עבריים מתמונות. המשימה שלך: לקרוא את הטקסט המדויק מכל גב ספר הנראה בתמונה.

חוקים מחייבים:
1. קרא את שם הספר המלא בדיוק כפי שכתוב - אל תקצר, אל תשנה, אל תשמיט מילים
2. קרא את שם המחבר המלא בדיוק כפי שכתוב על הגב
3. אם הטקסט חלקי או מכוסה - השלם לפי הידע שלך על הספר
4. כלול כל ספר עברי שנראה, גם אם הוא חלקי
5. שמות ספרים עבריים יכולים להיות ארוכים - קרא אותם במלואם
6. שמות מחברים יכולים להיות עבריים או תעתיק של שמות זרים

דוגמאות לקריאה נכונה:
- "אישה אל אחותה" ולא "אישה"
- "החטופה מאינקנדאר" ולא "החטופה"
- "מה שנטע אוהבת" ולא "מה שנשמע אוהב"
- "בחזרה לחיים" ולא "חזרה לחיים"

החזר JSON בלבד:
{"books":[{"title":"שם הספר המלא","author":"שם המחבר המלא","conf":90}]}
אם אין ספרים עבריים: {"books":[]}`;

  const keys = [env.GEMINI_KEY, env.GEMINI_KEY2, env.GEMINI_KEY3].filter(Boolean);
  if (!keys.length) {
    return new Response(JSON.stringify({ books: [], error: 'No API keys' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const models = ['gemini-2.0-flash', 'gemini-2.5-flash'];
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
        break;
      }

      if (data.error) {
        lastError = data.error.message;
        if (isQuotaError(lastError)) {
          quotaCount++;
          if (quotaCount % keys.length === 0) await sleep(800);
          continue;
        }
        continue;
      }

      if (!data.candidates?.length) { lastError = 'Empty candidates'; continue; }

      const parts = data.candidates[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (!text) { lastError = 'Empty text'; continue; }

      const parsed = parseBooks(text);
      if (parsed === null) { lastError = 'Parse failed'; continue; }
      if (parsed.length > 0) { books = parsed; break; }

      lastError = `No books (${model})`;
      break;
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

    const prompt = `You are an expert at reading Hebrew book spines. Read the EXACT and COMPLETE text from each book spine visible in the image.

Rules:
- Read the FULL book title exactly as written - do not shorten or omit words
- Read the FULL author name exactly as written
- Include every Hebrew book visible, even partially

Return ONLY JSON:
{"books":[{"title":"שם הספר המלא","author":"שם המחבר המלא","conf":85}]}
If no Hebrew books: {"books":[]}`;

    const binaryStr = atob(image);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [{ role: 'user', content: [
        { type: 'image', image: Array.from(bytes) },
        { type: 'text', text: prompt }
      ]}],
      max_tokens: 2048,
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
