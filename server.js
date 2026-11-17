'use strict';

const express = require('express');
const RSSParser = require('rss-parser');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const FEEDS_FILE = path.join(DATA_DIR, 'feeds.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ─── RSS Parser ───────────────────────────────────────────────────────────────
const parser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'FocusFeed/1.0 (RSS Reader)' },
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent'],
    ],
  },
});

// ─── Feed colors ─────────────────────────────────────────────────────────────
const FEED_COLORS = ['#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#3b82f6','#84cc16'];
let colorIndex = 0;

// ─── In-memory cache ──────────────────────────────────────────────────────────
let articleCache = []; // array of article objects
// Bound both caches: large subscriptions and HTML bodies can otherwise grow
// the process heap without limit.
const MAX_CACHED_ARTICLES = 5000;
const MAX_RSS_CONTENT_BYTES = 100 * 1024;
const fullTextCache = new Map();
const FULL_TEXT_CACHE_BYTES = 32 * 1024 * 1024;
let fullTextCacheBytes = 0;
let lastRefresh  = 0;
let refreshing   = false;
const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 min

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
// Canonical state shape, so every reader/writer agrees on the defaults.
const emptyState = () => ({ read: [], saved: [], readDates: {}, savedDates: {}, highlights: {} });
function readState() { return readJSON(STATE_FILE, emptyState()); }
function writeState(state) { writeJSON(STATE_FILE, state); }
function byNewest(a, b) {
  return (b.pubDate ? new Date(b.pubDate).getTime() : 0) - (a.pubDate ? new Date(a.pubDate).getTime() : 0);
}
function articleId(feedId, link) {
  return crypto.createHash('md5').update(feedId + (link || '')).digest('hex').slice(0, 12);
}
function readingTime(text) {
  if (!text) return 1;
  const words = stripHtml(text).split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}
function timeAgo(date) {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function excerpt(html, len = 200) {
  return stripHtml(html).slice(0, len);
}
function getImage(item) {
  // Try mediaThumbnail
  if (item.mediaThumbnail && item.mediaThumbnail.$) return item.mediaThumbnail.$.url;
  if (item.mediaContent  && item.mediaContent.$)   return item.mediaContent.$.url;
  // Try og:image style in content
  const src = (item.contentEncoded || item.content || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  if (src) return src[1];
  return null;
}

function clearFullTextCache() {
  fullTextCache.clear();
  fullTextCacheBytes = 0;
}

function cacheFullText(id, value) {
  // Map insertion order acts as an inexpensive LRU cache. Bound by bytes,
  // rather than entry count, because extracted article sizes vary widely.
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  const previous = fullTextCache.get(id);
  if (previous) fullTextCacheBytes -= previous.size;
  fullTextCache.delete(id);
  if (size > FULL_TEXT_CACHE_BYTES) return;

  fullTextCache.set(id, { value, size });
  fullTextCacheBytes += size;
  while (fullTextCacheBytes > FULL_TEXT_CACHE_BYTES) {
    const oldestId = fullTextCache.keys().next().value;
    const oldest = fullTextCache.get(oldestId);
    fullTextCache.delete(oldestId);
    fullTextCacheBytes -= oldest.size;
  }
}

function sanitizeExtractedDocument(document) {
  document.querySelectorAll('script, style, iframe, object, embed, form, base, link[rel="import"]').forEach(el => el.remove());
  document.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && /^(javascript|data):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return document.body.innerHTML;
}

async function extractFullText(article) {
  if (!article.link || !/^https?:\/\//i.test(article.link)) {
    return { content: article.content || '', extracted: false, reason: 'No usable article link' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(article.link, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FocusFeed/1.0 (personal RSS reader)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) throw new Error(`Article returned HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) {
      throw new Error(`Unsupported content type: ${type || 'unknown'}`);
    }

    const html = await response.text();
    // Protect the reader from unexpectedly huge response bodies.
    if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('Article is larger than 5 MB');
    const dom = new JSDOM(html, { url: response.url || article.link });
    const parsed = new Readability(dom.window.document).parse();
    if (!parsed?.content || stripHtml(parsed.content).length < 200) {
      throw new Error('Could not identify substantial article content');
    }

    // Reuse the parsed document for sanitizing instead of building a second DOM.
    dom.window.document.body.innerHTML = parsed.content;
    const content = sanitizeExtractedDocument(dom.window.document);
    return {
      content,
      title: parsed.title || article.title,
      author: parsed.byline || article.author || '',
      excerpt: parsed.excerpt || article.excerpt,
      readingTime: readingTime(content),
      extracted: true,
    };
  } catch (err) {
    console.warn(`[full-text] ${article.link}: ${err.message}`);
    return { content: article.content || '', extracted: false, reason: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Fetch a single feed ──────────────────────────────────────────────────────
async function fetchFeed(feed, parsed) {
  try {
    const result = parsed || await parser.parseURL(feed.url);
    const items  = (result.items || []).slice(0, 30);
    return items.map(item => {
      const link    = item.link || item.guid || '';
      const id      = articleId(feed.id, link);
      const body    = item.contentEncoded || item.content || item.summary || '';
      const rawText = body || item.title || '';
      const mins    = readingTime(rawText);
      const pubDate = item.pubDate || item.isoDate || null;
      return {
        id,
        feedId:      feed.id,
        feedTitle:   feed.title,
        feedColor:   feed.color,
        feedCategory:feed.category,
        title:       (item.title || 'Untitled').trim(),
        link,
        author:      item.creator || item.author || '',
        pubDate,
        timeAgo:     timeAgo(pubDate),
        excerpt:     excerpt(rawText),
        // Keep previews useful without letting one unusually large feed item
        // dominate the process heap.
        content:     body.slice(0, MAX_RSS_CONTENT_BYTES),
        image:       getImage(item),
        readingTime: mins,
        isRead:      false,
        isSaved:     false,
      };
    });
  } catch (err) {
    console.error(`[fetch] ${feed.title}: ${err.message}`);
    return [];
  }
}

// ─── Refresh all feeds ────────────────────────────────────────────────────────
async function refreshAllFeeds() {
  const feeds = readJSON(FEEDS_FILE, []);
  clearFullTextCache();
  const concurrency = 8;
  console.log(`[refresh] Fetching ${feeds.length} feeds (up to ${concurrency} at once)…`);

  // A large subscription list must not create hundreds of simultaneous network
  // connections. Keep parallelism bounded while retaining a responsive server.
  let nextIndex = 0;
  articleCache = [];
  refreshing = true;

  async function worker() {
    while (nextIndex < feeds.length) {
      const feed = feeds[nextIndex++];
      const items = await fetchFeed(feed);
      // Publish successful feed results as they arrive so the reader is usable
      // while a large refresh remains in progress.
      if (items.length) articleCache.push(...items);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, feeds.length) }, worker));

    // The list endpoint sorts on read, so a single sort here is enough.
    articleCache.sort(byNewest);
    if (articleCache.length > MAX_CACHED_ARTICLES) {
      articleCache.length = MAX_CACHED_ARTICLES;
    }

    lastRefresh = Date.now();
    console.log(`[refresh] Done — ${articleCache.length} articles cached`);
  } finally {
    refreshing = false;
  }
}

// ─── Merge state into articles ────────────────────────────────────────────────
function withState(articles) {
  const state = readState();
  const readSet  = new Set(state.read  || []);
  const savedSet = new Set(state.saved || []);
  const savedDates = state.savedDates || {};
  const highlights = state.highlights || {};
  return articles.map(a => ({
    ...a,
    isRead:  readSet.has(a.id),
    isSaved: savedSet.has(a.id),
    savedAt: savedDates[a.id] || null,
    highlights: highlights[a.id] || [],
  }));
}

// ─── Auto-refresh scheduler ───────────────────────────────────────────────────
function maybeRefresh() {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL) refreshAllFeeds();
}
setInterval(maybeRefresh, 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: feeds ───────────────────────────────────────────────────────────────
app.get('/api/feeds', (req, res) => {
  res.json(readJSON(FEEDS_FILE, []));
});

app.post('/api/feeds', async (req, res) => {
  const { url, category = 'general' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const feeds = readJSON(FEEDS_FILE, []);
  if (feeds.find(f => f.url === url)) return res.status(409).json({ error: 'feed already exists' });

  // Auto-fetch title
  let parsed = null;
  let title = url;
  try {
    parsed = await parser.parseURL(url);
    title = parsed.title || url;
  } catch { /* use url as fallback */ }

  const color = FEED_COLORS[colorIndex % FEED_COLORS.length];
  colorIndex++;
  const id = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
  const feed = { id, url, title, category, color, addedAt: new Date().toISOString() };
  feeds.push(feed);
  writeJSON(FEEDS_FILE, feeds);

  // Fetch articles for new feed, reusing the parse done for the title.
  const articles = await fetchFeed(feed, parsed);
  articleCache.push(...articles);
  articleCache.sort(byNewest);
  if (articleCache.length > MAX_CACHED_ARTICLES) {
    articleCache.length = MAX_CACHED_ARTICLES;
  }

  res.json(feed);
});

app.delete('/api/feeds/:id', (req, res) => {
  const feeds = readJSON(FEEDS_FILE, []);
  const idx = feeds.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  feeds.splice(idx, 1);
  writeJSON(FEEDS_FILE, feeds);
  // Remove from cache
  articleCache = articleCache.filter(a => a.feedId !== req.params.id);
  res.json({ ok: true });
});

// ─── API: articles ────────────────────────────────────────────────────────────
app.get('/api/articles', (req, res) => {
  const { filter = 'unread', feed, category, search, sort = 'newest' } = req.query;
  let articles = withState(articleCache);

  if (filter === 'unread') articles = articles.filter(a => !a.isRead);
  if (filter === 'saved')  articles = articles.filter(a => a.isSaved);

  if (feed)     articles = articles.filter(a => a.feedId === feed);
  if (category) articles = articles.filter(a => a.feedCategory === category);
  if (search) {
    const q = search.toLowerCase();
    articles = articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.excerpt.toLowerCase().includes(q) ||
      a.feedTitle.toLowerCase().includes(q)
    );
  }

  if (sort === 'oldest') {
    articles.sort((a, b) => new Date(a.pubDate || 0) - new Date(b.pubDate || 0));
  } else if (sort === 'reading_time') {
    articles.sort((a, b) => a.readingTime - b.readingTime);
  } else if (filter === 'saved') {
    // Saved groups are based on when the user saved an article, not when it was published.
    articles.sort((a, b) => new Date(b.savedAt || b.pubDate || 0) - new Date(a.savedAt || a.pubDate || 0));
  } else {
    articles.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  }

  // Feed HTML is only needed by the reader endpoint. Do not send it with the
  // list response: keeping thousands of previews in the browser is wasteful.
  res.json(articles.map(({ content, ...metadata }) => metadata));
});

// ─── API: full-text article extraction ───────────────────────────────────────
// Feed previews are immediate; opening an entry asks Readability to retrieve the
// publisher page and return its main article body, similar to Feedbin's full-text view.
app.get('/api/articles/:id/content', async (req, res) => {
  const cached = fullTextCache.get(req.params.id);
  if (cached) {
    // Refresh LRU position on access without copying the article body.
    fullTextCache.delete(req.params.id);
    fullTextCache.set(req.params.id, cached);
    return res.json({ ...cached.value, cached: true });
  }

  const article = articleCache.find(a => a.id === req.params.id);
  if (!article) return res.status(404).json({ error: 'article not found' });

  const result = await extractFullText(article);
  cacheFullText(req.params.id, result);
  res.json({ ...result, cached: false });
});

// ─── API: article state ───────────────────────────────────────────────────────
function updateState(id, action) {
  const state = readState();

  if (action === 'read') {
    if (!state.read.includes(id)) state.read.push(id);
    state.readDates[id] = new Date().toISOString();
  } else if (action === 'unread') {
    state.read = state.read.filter(x => x !== id);
    delete state.readDates[id];
  } else if (action === 'save') {
    if (!state.saved.includes(id)) {
      state.saved.push(id);
      state.savedDates[id] = new Date().toISOString();
    }
  } else if (action === 'unsave') {
    state.saved = state.saved.filter(x => x !== id);
    delete state.savedDates[id];
  }

  writeState(state);
}

app.post('/api/articles/:id/read',   (req, res) => { updateState(req.params.id, 'read');   res.json({ ok: true }); });
app.post('/api/articles/:id/unread', (req, res) => { updateState(req.params.id, 'unread'); res.json({ ok: true }); });
app.post('/api/articles/:id/save',   (req, res) => { updateState(req.params.id, 'save');   res.json({ ok: true }); });
app.post('/api/articles/:id/unsave', (req, res) => { updateState(req.params.id, 'unsave'); res.json({ ok: true }); });

// ─── API: saved text highlights ───────────────────────────────────────────────
app.get('/api/articles/:id/highlights', (req, res) => {
  const state = readState();
  res.json(state.highlights?.[req.params.id] || []);
});

app.post('/api/articles/:id/highlights', (req, res) => {
  const { quote, prefix = '', suffix = '', start, end } = req.body || {};
  if (typeof quote !== 'string' || !quote.trim()) {
    return res.status(400).json({ error: 'quote required' });
  }
  if (quote.length > 10000) return res.status(400).json({ error: 'highlight is too long' });

  const state = readState();
  const highlights = state.highlights[req.params.id] || [];
  const highlight = {
    id: crypto.randomUUID(),
    quote: quote.trim(),
    prefix: String(prefix).slice(-100),
    suffix: String(suffix).slice(0, 100),
    start: Number.isInteger(start) ? start : null,
    end: Number.isInteger(end) ? end : null,
    createdAt: new Date().toISOString(),
  };
  // Avoid creating duplicate highlights when a selection is submitted twice.
  const duplicate = highlights.find(h => h.quote === highlight.quote && h.start === highlight.start && h.end === highlight.end);
  if (duplicate) return res.json(duplicate);
  highlights.push(highlight);
  state.highlights[req.params.id] = highlights;
  writeState(state);
  res.status(201).json(highlight);
});

app.delete('/api/articles/:id/highlights/:highlightId', (req, res) => {
  const state = readState();
  const highlights = state.highlights[req.params.id] || [];
  const next = highlights.filter(h => h.id !== req.params.highlightId);
  if (next.length === highlights.length) return res.status(404).json({ error: 'highlight not found' });
  state.highlights[req.params.id] = next;
  writeState(state);
  res.json({ ok: true });
});

// ─── API: mark all read ───────────────────────────────────────────────────────
app.post('/api/mark-all-read', (req, res) => {
  const { feedId } = req.body || {};
  const state = readState();
  const readSet = new Set(state.read);

  const toMark = feedId
    ? articleCache.filter(a => a.feedId === feedId)
    : articleCache;

  const now = new Date().toISOString();
  toMark.forEach(a => {
    if (!readSet.has(a.id)) {
      readSet.add(a.id);
      state.read.push(a.id);
    }
    state.readDates[a.id] = now;
  });

  writeState(state);
  res.json({ ok: true, marked: toMark.length });
});

// ─── API: refresh ─────────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  await refreshAllFeeds();
  res.json({ ok: true, count: articleCache.length, lastRefresh });
});

// ─── API: stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const state = readState();
  const readDates = state.readDates;
  const readSet = new Set(state.read);
  const today = new Date().toDateString();

  let readToday = 0;
  const daySet = new Set();

  Object.values(readDates).forEach(d => {
    const date = new Date(d);
    if (date.toDateString() === today) readToday++;
    daySet.add(date.toDateString());
  });

  // Calculate streak (consecutive days up to today)
  let streak = 0;
  const check = new Date();
  while (daySet.has(check.toDateString())) {
    streak++;
    check.setDate(check.getDate() - 1);
  }

  // Single pass over the cache for both the total and per-feed unread counts.
  let unreadCount = 0;
  const unreadByFeed = {};
  for (const article of articleCache) {
    if (readSet.has(article.id)) continue;
    unreadCount++;
    unreadByFeed[article.feedId] = (unreadByFeed[article.feedId] || 0) + 1;
  }

  res.json({
    readToday,
    totalRead:  readSet.size,
    totalSaved: state.saved.length,
    streak,
    unreadCount,
    unreadByFeed,
    savedCount: state.saved.length,
    refreshing,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  app.listen(PORT, () => {
    console.log(`⚡ FocusFeed running at http://localhost:${PORT}`);
    console.log('   Fetching feeds in background…');
  });

  // Initial fetch (non-blocking)
  refreshAllFeeds();
}

start().catch(console.error);
