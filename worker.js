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
      const { image, mimeType } = body;

      // בעיה 6 תוקנה: בדיקת image לפני שימוש
      if (!image || typeof image !== 'string') {
        return new Response(JSON.stringify({ books: [], error: 'Missing or invalid image data' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      let mime = mimeType || 'image/jpeg';
      if (image.startsWith('/9j/')) mime = 'image/jpeg';
      else if (image.startsWith('iVBOR')) mime = 'image/png';
      else if (image.startsWith('R0lGO')) mime = 'image/gif';
      else if (image.startsWith('UklGR')) mime = 'image/webp';

      // בעיה 1 תוקנה: פרומפט שמאפשר לGemini להשתמש בידע שלו
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

      const keys = [
        env.GEMINI_KEY,
        env.GEMINI_KEY2,
        env.GEMINI_KEY3,
      ].filter(Boolean);

      // בעיה 7 תוקנה: בדיקה שיש keys
      if (keys.length === 0) {
        return new Response(JSON.stringify({ books: [], error: 'No API keys configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // בעיה 3 תוקנה: שם מודל נכון ל-2.5
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
                  contents: [{
                    parts: [
                      { inline_data: { mime_type: mime, data: image } },
                      { text: prompt }
                    ]
                  }],
                  generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 2048,
                    responseMimeType: 'application/json',
                  }
                })
              }
            );
          } catch (fetchErr) {
            lastError = fetchErr.message;
            continue;
          }

          const data = await res.json();

          // בעיה 4 תוקנה: בדיקת safety filter
          if (data.promptFeedback?.blockReason) {
            lastError = `Blocked: ${data.promptFeedback.blockReason}`;
            break outer;
          }

          if (data.error) {
            lastError = data.error.message;
            // בעיה 5 תוקנה: הוסף RATE_LIMIT_EXCEEDED
            const isQuota =
              data.error.message.includes('quota') ||
              data.error.message.includes('RESOURCE_EXHAUSTED') ||
              data.error.message.includes('RATE_LIMIT_EXCEEDED') ||
              data.error.message.includes('high demand') ||
              data.error.message.includes('overloaded');
            if (isQuota) continue;
            continue; // כל שגיאה - נסה key/model הבא
          }

          // בעיה 4 תוקנה: candidates ריק
          if (!data.candidates || data.candidates.length === 0) {
            lastError = 'Empty candidates - possible safety filter';
            continue;
          }

          const parts = data.candidates[0]?.content?.parts || [];
          const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();

          if (!text) {
            lastError = 'Empty text response from Gemini';
            continue;
          }

          let parsed = [];
          try {
            const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
            const jsonMatch = clean.match(/\{[\s\S]*"books"[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]).books || [];
          } catch (e) {
            try {
              const match = text.match(/"books"\s*:\s*(\[[\s\S]*?\])/);
              if (match) parsed = JSON.parse(match[1]);
            } catch (e2) {
              lastError = 'JSON parse error: ' + text.substring(0, 100);
              continue;
            }
          }

          // בעיה 2 תוקנה: done רק אם קיבלנו ספרים בפועל
          if (parsed.length > 0) {
            books = parsed;
            break outer;
          }

          // Gemini ענה אך החזיר [] - נסה model הבא
          lastError = 'No Hebrew books detected by ' + model;
        }
      }

      return new Response(JSON.stringify({
        books,
        error: books.length === 0 ? lastError : null
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, books: [] }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}
