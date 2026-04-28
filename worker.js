/**
 * LunmeCHU Naver Search Proxy
 * Cloudflare Worker that proxies Naver Search API to enrich KakaoMap
 * results with popularity signals (blog/cafe/news counts).
 *
 * Required environment variables (set in Cloudflare dashboard):
 *   NAVER_CLIENT_ID
 *   NAVER_CLIENT_SECRET
 *
 * Optional: ALLOWED_ORIGINS (comma-separated, defaults to "*")
 *
 * Endpoint: POST /
 * Request body:
 *   { places: [{ name: "가게명", region: "지역명" }, ...] }
 *
 * Response:
 *   {
 *     results: [
 *       {
 *         name: "...",
 *         blogCount: 1234,
 *         cafeCount: 567,
 *         newsCount: 89,
 *         topBlog: "최근 블로그 제목 발췌"
 *       },
 *       ...
 *     ]
 *   }
 */

const MAX_PLACES_PER_REQUEST = 25;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, env);
    }

    if (request.method !== "POST") {
      return corsResponse({ error: "Method not allowed" }, 405, env);
    }

    if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
      return corsResponse(
        { error: "Naver credentials not configured (set NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)" },
        500,
        env
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return corsResponse({ error: "Invalid JSON body" }, 400, env);
    }

    const places = Array.isArray(body.places)
      ? body.places.slice(0, MAX_PLACES_PER_REQUEST)
      : [];

    if (places.length === 0) {
      return corsResponse({ results: [] }, 200, env);
    }

    const results = await Promise.all(
      places.map((p) => enrichPlace(p, env))
    );

    return corsResponse({ results }, 200, env);
  },
};

async function enrichPlace(place, env) {
  const name = (place.name || "").trim();
  const region = (place.region || "").trim();
  const query = region ? `${name} ${region}` : name;

  if (!name) {
    return { name: "", blogCount: 0, cafeCount: 0, newsCount: 0 };
  }

  try {
    const [blog, cafe, news] = await Promise.allSettled([
      fetchNaver("blog", query, env),
      fetchNaver("cafearticle", query, env),
      fetchNaver("news", query, env),
    ]);

    const blogVal = blog.status === "fulfilled" ? blog.value : null;
    const cafeVal = cafe.status === "fulfilled" ? cafe.value : null;
    const newsVal = news.status === "fulfilled" ? news.value : null;

    return {
      name: place.name,
      blogCount: blogVal?.total || 0,
      cafeCount: cafeVal?.total || 0,
      newsCount: newsVal?.total || 0,
      topBlog: stripHtml(blogVal?.items?.[0]?.title) || null,
    };
  } catch (e) {
    return {
      name: place.name,
      blogCount: 0,
      cafeCount: 0,
      newsCount: 0,
      error: String(e.message || e),
    };
  }
}

async function fetchNaver(type, query, env) {
  const url = `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=1`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": env.NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET,
    },
  });
  if (!res.ok) {
    throw new Error(`Naver ${type} API ${res.status}`);
  }
  return res.json();
}

function stripHtml(s) {
  return s ? String(s).replace(/<[^>]+>/g, "") : null;
}

function corsResponse(data, status, env) {
  const allowedOrigin = env?.ALLOWED_ORIGINS || "*";
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (data === null) {
    return new Response(null, { status, headers });
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
