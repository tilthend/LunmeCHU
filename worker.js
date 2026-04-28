/**
 * LunmeCHU Naver Search Proxy (v2 — with image picker)
 *
 * Cloudflare Worker that proxies Naver Search API to enrich KakaoMap
 * results with popularity signals (blog/cafe/news counts) AND a
 * heuristically-picked representative image.
 *
 * Required environment variables (set in Cloudflare dashboard):
 *   NAVER_CLIENT_ID
 *   NAVER_CLIENT_SECRET
 *
 * Optional: ALLOWED_ORIGINS (defaults to "*")
 *
 * Endpoint: POST /
 * Request body: { places: [{ name: "가게명", region: "지역명" }, ...] }
 * Response:
 *   { results: [{ name, blogCount, cafeCount, newsCount, topBlog, imageUrl, imageScore }, ...] }
 */

const MAX_PLACES_PER_REQUEST = 25;
const IMAGE_CANDIDATES = 10;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsResponse(null, 204, env);
    if (request.method !== "POST") return corsResponse({ error: "Method not allowed" }, 405, env);
    if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
      return corsResponse({ error: "Naver credentials not configured" }, 500, env);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return corsResponse({ error: "Invalid JSON body" }, 400, env); }

    const places = Array.isArray(body.places) ? body.places.slice(0, MAX_PLACES_PER_REQUEST) : [];
    if (places.length === 0) return corsResponse({ results: [] }, 200, env);

    const results = await Promise.all(places.map((p) => enrichPlace(p, env)));
    return corsResponse({ results }, 200, env);
  },
};

async function enrichPlace(place, env) {
  const name = (place.name || "").trim();
  const region = (place.region || "").trim();
  const query = region ? `${name} ${region}` : name;

  if (!name) return emptyResult("");

  try {
    const [blog, cafe, news, image] = await Promise.allSettled([
      fetchNaver("blog", query, env, 1),
      fetchNaver("cafearticle", query, env, 1),
      fetchNaver("news", query, env, 1),
      fetchNaver("image", query, env, IMAGE_CANDIDATES),
    ]);

    const blogVal = blog.status === "fulfilled" ? blog.value : null;
    const cafeVal = cafe.status === "fulfilled" ? cafe.value : null;
    const newsVal = news.status === "fulfilled" ? news.value : null;
    const imageVal = image.status === "fulfilled" ? image.value : null;

    const picked = pickRepresentativeImage(imageVal?.items || [], name);

    return {
      name: place.name,
      blogCount: blogVal?.total || 0,
      cafeCount: cafeVal?.total || 0,
      newsCount: newsVal?.total || 0,
      topBlog: stripHtml(blogVal?.items?.[0]?.title) || null,
      imageUrl: picked?.url || null,
      imageScore: picked?.score || 0,
      imageTitle: picked?.title || null,
    };
  } catch (e) {
    return { ...emptyResult(place.name), error: String(e.message || e) };
  }
}

async function fetchNaver(type, query, env, display) {
  const url = `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=${display || 1}`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": env.NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET,
    },
  });
  if (!res.ok) throw new Error(`Naver ${type} ${res.status}`);
  return res.json();
}

/**
 * 휴리스틱 기반 대표사진 picker.
 * 후보 이미지들을 채점해서 "가장 가게 대표 사진같은" 것을 선택.
 */
function pickRepresentativeImage(images, placeName) {
  if (!images || images.length === 0) return null;

  const FOOD_KEYWORDS = ["음식", "메뉴", "맛집", "요리", "플레이팅", "인테리어", "내부", "외관", "입구", "맛", "분위기", "테이블"];
  const BAD_KEYWORDS = ["지도", "약도", "위치", "로고", "가는길", "찾아가는", "주소"];
  const placeLower = (placeName || "").toLowerCase();

  const scored = images.map((img) => {
    let score = 0;
    const title = stripHtml(img.title || "").toLowerCase();
    const w = parseInt(img.sizewidth) || 0;
    const h = parseInt(img.sizeheight) || 0;
    const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 99;

    // 사이즈 점수
    if (w >= 600 && h >= 400) score += 10;
    else if (w >= 300 && h >= 200) score += 5;
    else score -= 3;

    // 가로세로비 점수 (정사각·정상비율 선호)
    if (ratio <= 1.5) score += 8;
    else if (ratio <= 2.5) score += 3;
    else score -= 8;

    // 가게명이 제목에 들어있으면 강한 신호
    if (placeLower && title.includes(placeLower)) score += 15;

    // 음식·인테리어 관련 키워드
    FOOD_KEYWORDS.forEach((kw) => { if (title.includes(kw)) score += 3; });

    // 지도·로고 등 부적절 키워드
    BAD_KEYWORDS.forEach((kw) => { if (title.includes(kw)) score -= 15; });

    return {
      score,
      url: img.thumbnail || img.link,
      fullUrl: img.link,
      title: stripHtml(img.title || ""),
      width: w,
      height: h,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function emptyResult(name) {
  return { name, blogCount: 0, cafeCount: 0, newsCount: 0, topBlog: null, imageUrl: null, imageScore: 0, imageTitle: null };
}

function stripHtml(s) { return s ? String(s).replace(/<[^>]+>/g, "") : null; }

function corsResponse(data, status, env) {
  const allowedOrigin = env?.ALLOWED_ORIGINS || "*";
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (data === null) return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
