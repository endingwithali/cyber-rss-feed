'use strict';

/* ══ Suggested feeds ══════════════════════════════════════════════════════════ */
const SUGGESTED = [
  { url: 'https://news.ycombinator.com/rss',                label: 'Hacker News' },
  { url: 'https://www.theverge.com/rss/index.xml',          label: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', label: 'Ars Technica' },
  { url: 'https://www.wired.com/feed/rss',                  label: 'Wired' },
  { url: 'http://feeds.bbci.co.uk/news/rss.xml',            label: 'BBC News' },
  { url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',  label: 'NASA' },
  { url: 'https://www.smashingmagazine.com/feed/',          label: 'Smashing Magazine' },
  { url: 'https://css-tricks.com/feed/',                    label: 'CSS-Tricks' },
  { url: 'https://dev.to/feed',                             label: 'Dev.to' },
];

/* ══ State ════════════════════════════════════════════════════════════════════ */
let state = {
  articles:       [],
  feeds:          [],
  filter:         'unread',
  activeFeed:     null,
  activeCategory: null,
  search:         '',
  sort:           'newest',
  focusIdx:       0,
  currentArticle: null,
  sprintMode:     false,
  sprintCount:    0,
  sprintGoal:     3,
  loading:        false,
  // Keep the inbox from becoming the task: reveal stories in small batches.
  listChunk:      12,
  listLimit:      12,
  unreadByFeed:   {},
  groups:         [],
  activeGroup:    null,
};

/* Feed URL map (feedId → url) for favicons */
let feedUrlMap = {};

/* ══ DOM refs ════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const articleList    = $('articleList');
const feedList       = $('feedList');
const groupList      = $('groupList');
const loadingState   = $('loadingState');
const emptyState     = $('emptyState');
const searchInput    = $('searchInput');
const sortSelect     = $('sortSelect');
const sprintBanner   = $('sprintBanner');
const sprintLabel    = $('sprintLabel');
const sprintBarFill  = $('sprintBarFill');
const readerScrollArea   = $('readerScrollArea');
const readerProgressFill = $('readerProgressFill');

/* ══ API helpers ═════════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}
const GET    = path       => api('GET',    path);
const POST   = (path, b)  => api('POST',   path, b);
const DELETE = path       => api('DELETE', path);

/* ══ Sanitize HTML ════════════════════════════════════════════════════════════ */
function sanitizeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi,   '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(\/?)figure([^>]*)>/gi, '<$1div$2>')
    .replace(/<figcaption/gi, '<p class="caption"')
    .replace(/<\/figcaption>/gi, '</p>');
}

/* ══ Time helpers ════════════════════════════════════════════════════════════ */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ══ Favicon helpers ══════════════════════════════════════════════════════════ */
function feedDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function faviconUrl(feedId) {
  const url = feedUrlMap[feedId] || '';
  const d = feedDomain(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=32` : '';
}

function buildFeedUrlMap() {
  feedUrlMap = {};
  state.feeds.forEach(f => { feedUrlMap[f.id] = f.url; });
}

/* ══ Toast ═══════════════════════════════════════════════════════════════════ */
function showToast(msg, type) {
  const container = $('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  }, 2500);
}

/* ══ Celebration ══════════════════════════════════════════════════════════════ */
function showCelebration() {
  $('celebrationOverlay').classList.remove('hidden');
}
function hideCelebration() {
  $('celebrationOverlay').classList.add('hidden');
}

/* ══ Sprint ══════════════════════════════════════════════════════════════════ */
function updateSprintBanner() {
  if (!state.sprintMode) {
    sprintBanner.classList.add('hidden');
    $('btnSprintSidebar').classList.remove('sprint-active');
    return;
  }
  sprintBanner.classList.remove('hidden');
  sprintLabel.textContent = `Sprint: ${state.sprintCount} / ${state.sprintGoal}`;
  const pct = Math.min(100, (state.sprintCount / state.sprintGoal) * 100);
  sprintBarFill.style.width = pct + '%';
  $('btnSprintSidebar').classList.add('sprint-active');
}

function toggleSprint() {
  state.sprintMode = !state.sprintMode;
  if (state.sprintMode) {
    state.sprintCount = 0;
    showToast('⚡ Sprint started! Read 3 articles.');
  } else {
    showToast('Sprint stopped.');
  }
  updateSprintBanner();
}

function incrementSprint() {
  if (!state.sprintMode) return;
  state.sprintCount++;
  updateSprintBanner();
  if (state.sprintCount >= state.sprintGoal) {
    state.sprintMode = false;
    updateSprintBanner();
    setTimeout(showCelebration, 400);
  }
}

/* ══ Stats ════════════════════════════════════════════════════════════════════ */
async function updateStats() {
  try {
    const stats = await GET('/api/stats');
    $('statToday').textContent  = `${stats.readToday} today`;
    $('statStreak').textContent = `${stats.streak} 🔥`;

    const unreadCount = stats.unreadCount || 0;
    const savedCount  = stats.savedCount  || 0;
    state.unreadByFeed = stats.unreadByFeed || {};

    const unreadEl = $('countUnread');
    const savedEl  = $('countSaved');

    unreadEl.textContent = unreadCount;
    savedEl.textContent  = savedCount;

    // Keep the unread total visible, including when it reaches zero.
    unreadEl.classList.remove('hidden');
    savedEl.classList.toggle('hidden', savedCount === 0);
    renderFeeds();
  } catch { /* non-critical */ }
}

/* ══ Theme ════════════════════════════════════════════════════════════════════ */
function setTheme(t) {
  localStorage.setItem('theme', t);
  applyTheme(t);
  document.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeBtn === t);
  });
}

function applyTheme(t) {
  if (t === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dusk' : 'day');
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'auto';
  applyTheme(saved);
  document.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeBtn === saved);
  });
}

/* ══ Resizable panes ═════════════════════════════════════════════════════════ */
const PANE_LIMITS = { sidebar: 180, list: 280, reader: 360 };

function paneElement(name) {
  return name === 'sidebar' ? $('sidebar') : $('listPane');
}

function maxPaneWidth(name) {
  const other = name === 'sidebar' ? $('listPane') : $('sidebar');
  const available = window.innerWidth - other.offsetWidth - PANE_LIMITS.reader - 14;
  return Math.max(PANE_LIMITS[name], available);
}

function resizePane(name, width, persist = true) {
  const safeWidth = Math.round(Math.max(PANE_LIMITS[name], Math.min(maxPaneWidth(name), width)));
  paneElement(name).style.width = `${safeWidth}px`;
  if (persist) localStorage.setItem(`focusfeed.${name}Width`, String(safeWidth));
}

function restorePaneWidths() {
  ['sidebar', 'list'].forEach(name => {
    const saved = Number(localStorage.getItem(`focusfeed.${name}Width`));
    if (Number.isFinite(saved) && saved > 0) resizePane(name, saved, false);
  });
}

function setupColumnResizers() {
  const handles = [
    { el: $('sidebarResize'), pane: 'sidebar' },
    { el: $('listResize'), pane: 'list' },
  ];

  handles.forEach(({ el, pane }) => {
    el.addEventListener('pointerdown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = paneElement(pane).offsetWidth;
      el.setPointerCapture(event.pointerId);
      el.classList.add('is-dragging');
      document.body.classList.add('is-resizing');

      const onMove = moveEvent => resizePane(pane, startWidth + moveEvent.clientX - startX, false);
      const onEnd = endEvent => {
        resizePane(pane, paneElement(pane).offsetWidth);
        el.releasePointerCapture(endEvent.pointerId);
        el.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onEnd);
        el.removeEventListener('pointercancel', onEnd);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onEnd);
      el.addEventListener('pointercancel', onEnd);
    });

    el.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 20;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        resizePane(pane, paneElement(pane).offsetWidth - step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        resizePane(pane, paneElement(pane).offsetWidth + step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        resizePane(pane, PANE_LIMITS[pane]);
      } else if (event.key === 'End') {
        event.preventDefault();
        resizePane(pane, maxPaneWidth(pane));
      }
    });
  });

  window.addEventListener('resize', () => {
    ['sidebar', 'list'].forEach(name => resizePane(name, paneElement(name).offsetWidth, false));
  });
}

/* ══ List title ══════════════════════════════════════════════════════════════ */
function updateListTitle() {
  const titles = { all: 'All Articles', unread: 'Unread', saved: 'Saved' };
  let title = titles[state.filter] || 'Articles';
  if (state.activeFeed) {
    const feed = state.feeds.find(f => f.id === state.activeFeed);
    if (feed) title = feed.title;
  }
  $('listTitle').textContent = title;
  const visible = Math.min(state.listLimit, state.articles.length);
  $('listCount').textContent = state.articles.length
    ? `${visible} in view`
    : ''; 
}

function savedGroupLabel(savedAt) {
  if (!savedAt) return 'Older saved';
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return 'Older saved';
  const age = Date.now() - saved.getTime();
  if (age <= 24 * 60 * 60 * 1000) return 'Past day';
  if (age <= 7 * 24 * 60 * 60 * 1000) return 'Past week';
  if (age <= 30 * 24 * 60 * 60 * 1000) return 'Past 30 days';
  return 'Older saved';
}

function entryDateLabel(pubDate) {
  const date = pubDate ? new Date(pubDate) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Earlier';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((today - day) / 86_400_000);
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo < 7) return 'This week';
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ══ Render Feeds ════════════════════════════════════════════════════════════ */
function renderFeeds() {
  // Counts come from the global stats response, rather than the currently
  // selected filter/feed, so every feed keeps its real unread total visible.
  const unreadByFeed = state.unreadByFeed;
  const groups = new Map();
  state.feeds.forEach(feed => {
    const category = (feed.category || 'General').trim() || 'General';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(feed);
  });

  const markup = [];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, feeds]) => {
    markup.push(`<li class="feed-category-heading" role="presentation">${escHtml(category)}</li>`);
    feeds.forEach(f => {
      const count  = unreadByFeed[f.id] || 0;
      const active = state.activeFeed === f.id ? 'active' : '';
      const domain = feedDomain(f.url);
      const fav = domain
        ? `<img class="feed-favicon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" width="14" height="14" alt="" onerror="this.style.display='none'">`
        : '<span style="display:inline-block;width:14px;height:14px;margin-right:0;flex-shrink:0"></span>';
      markup.push(`<li class="feed-item ${active}" data-feed-id="${f.id}" title="${escHtml(f.title)}">
        ${fav}<span class="feed-name">${escHtml(f.title)}</span>
        <span class="feed-unread" aria-label="${count} unread">${count}</span>
        <button class="feed-delete" data-delete-feed="${f.id}" title="Remove feed">×</button>
      </li>`);
    });
  });
  feedList.innerHTML = markup.join('');
}

function renderGroups() {
  groupList.innerHTML = state.groups.map(group => `
    <li class="group-item ${state.activeGroup === group.name ? 'active' : ''}" data-group="${escHtml(group.name)}">
      <span class="group-name">${escHtml(group.name)}</span><span class="group-count">${group.count}</span>
    </li>`).join('');
}

async function loadGroups() {
  try { state.groups = await GET('/api/groups'); renderGroups(); } catch { state.groups = []; }
}

/* ══ Render Entry (compact row) ══════════════════════════════════════════════ */
function renderEntry(a, i) {
  const isSelected = state.currentArticle && state.currentArticle.id === a.id;
  const unreadCls  = a.isRead ? '' : 'unread';
  const selectedCls = isSelected ? 'selected' : '';
  const favSrc = faviconUrl(a.feedId);
  const favImg = favSrc
    ? `<img class="entry-favicon" src="${escHtml(favSrc)}" width="16" height="16" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span style="width:16px;height:16px;margin-right:8px;flex-shrink:0;display:inline-block"></span>`;

  const savedCls = a.isSaved ? 'saved' : '';

  return `
    <li class="entry ${unreadCls} ${selectedCls}"
        data-idx="${i}"
        data-id="${a.id}"
        tabindex="0">
      <div class="entry-unread-strip"></div>
      ${favImg}
      <div class="entry-content">
        <div class="entry-title">${escHtml(a.title)}</div>
        <div class="entry-byline">
          <span class="entry-feed-name">${escHtml(a.feedTitle)}</span>
          <span class="entry-byline-sep">·</span>
          <time class="entry-time" datetime="${escHtml(a.pubDate || '')}">${a.timeAgo || timeAgo(a.pubDate)}</time>
          <span class="entry-byline-sep">·</span>
          <span class="entry-reading-time">${a.readingTime} min</span>
        </div>
        ${a.highlights?.length ? `<div class="entry-highlights"><span class="highlight-mark">▌</span>${escHtml(a.highlights[0].quote)}${a.highlights.length > 1 ? ` <span class="highlight-more">+${a.highlights.length - 1} more</span>` : ''}</div>` : ''}
      </div>
      <button class="entry-save-btn ${savedCls}" data-action="save" data-id="${a.id}" title="${a.isSaved ? 'Unsave' : 'Save'}">
        ${a.isSaved ? '🔖' : '☆'}
      </button>
    </li>`;
}

/* ══ Render Articles ══════════════════════════════════════════════════════════ */
function renderArticles() {
  loadingState.classList.add('hidden');

  if (state.articles.length === 0) {
    emptyState.classList.remove('hidden');
    articleList.innerHTML = '';
    return;
  }

  emptyState.classList.add('hidden');
  const visibleArticles = state.articles.slice(0, state.listLimit);
  let previousGroup = '';
  const entries = visibleArticles.map((a, i) => {
    const group = state.filter === 'saved'
      ? savedGroupLabel(a.savedAt)
      : entryDateLabel(a.pubDate);
    const separator = group !== previousGroup
      ? `<li class="entry-date-group" role="presentation"><span>${escHtml(group)}</span></li>`
      : '';
    previousGroup = group;
    return separator + renderEntry(a, i);
  }).join('');

  const remaining = state.articles.length - visibleArticles.length;
  const queueFooter = remaining > 0 ? `
    <li class="queue-footer">
      <p class="queue-footer-title">That’s a good-sized batch.</p>
      <p class="queue-footer-sub">${remaining.toLocaleString()} more waiting when you want them.</p>
      <div class="queue-footer-actions">
        <button class="queue-more-btn" data-action="show-more">Show ${Math.min(state.listChunk, remaining)} more</button>
        <button class="queue-all-btn" data-action="show-all">Show all</button>
      </div>
    </li>` : '';

  articleList.innerHTML = entries + queueFooter;
  updateListTitle();
  scrollFocusedIntoView();
}

/* ══ Load Articles ════════════════════════════════════════════════════════════ */
async function loadArticles(showSpinner) {
  if (showSpinner) {
    state.loading = true;
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    articleList.innerHTML = '';
  }

  const params = new URLSearchParams({ filter: state.filter, sort: state.sort });
  if (state.activeFeed)     params.set('feed',     state.activeFeed);
  if (state.activeCategory) params.set('category', state.activeCategory);
  if (state.activeGroup)    params.set('group', state.activeGroup);
  if (state.search)         params.set('search',   state.search);

  try {
    state.articles = await GET(`/api/articles?${params}`);
    state.focusIdx = 0;
    state.listLimit = state.listChunk;
    state.loading  = false;
    renderArticles();
    await updateStats();
    await loadGroups();
  } catch (err) {
    console.error(err);
    state.loading = false;
    loadingState.classList.add('hidden');
    showToast('Failed to load articles', 'warning');
  }
}

/* ══ Article Actions ══════════════════════════════════════════════════════════ */
function getFocusedArticle() {
  return state.articles[state.focusIdx] || null;
}

function getEntryEl(id) {
  return articleList.querySelector(`[data-id="${id}"]`);
}

function getFocusedEntryEl() {
  return articleList.querySelector(`[data-idx="${state.focusIdx}"]`);
}

async function markRead(id, silent) {
  const a = state.articles.find(x => x.id === id);
  if (!a || a.isRead) return;
  try {
    await POST(`/api/articles/${id}/read`);
    a.isRead = true;
    incrementSprint();
    if (!silent) showToast('✓ Marked read');
    renderArticles();
    updateReaderToolbar();
    await updateStats();
  } catch { showToast('Error marking read', 'warning'); }
}

async function markUnread(id) {
  const a = state.articles.find(x => x.id === id);
  if (!a || !a.isRead) return;
  try {
    await POST(`/api/articles/${id}/unread`);
    a.isRead = false;
    showToast('↩ Marked unread');
    renderArticles();
    updateReaderToolbar();
    await updateStats();
  } catch { showToast('Error marking unread', 'warning'); }
}

async function toggleSave(id) {
  const a = state.articles.find(x => x.id === id);
  if (!a) return;
  try {
    if (a.isSaved) {
      await POST(`/api/articles/${id}/unsave`);
      a.isSaved = false;
      showToast('Removed from saved');
    } else {
      await POST(`/api/articles/${id}/save`);
      a.isSaved = true;
      showToast('🔖 Saved');
    }
    renderArticles();
    updateReaderToolbar();
    await updateStats();
  } catch { showToast('Error saving', 'warning'); }
}

function dismissCard(id) {
  const el = getEntryEl(id);
  if (!el) return;
  el.classList.add('entry-dismiss');
  el.addEventListener('transitionend', () => {
    const idx = state.articles.findIndex(a => a.id === id);
    if (idx !== -1) state.articles.splice(idx, 1);
    if (state.focusIdx >= state.articles.length) {
      state.focusIdx = Math.max(0, state.articles.length - 1);
    }
    renderArticles();
    updateStats();
  }, { once: true });
}

async function dismissAndRead(id) {
  const a = state.articles.find(x => x.id === id);
  if (!a) return;
  try {
    if (!a.isRead) {
      await POST(`/api/articles/${id}/read`);
      a.isRead = true;
      incrementSprint();
    }
    dismissCard(id);
    showToast('↓ Dismissed');
  } catch { showToast('Error', 'warning'); }
}

function openInBrowser(id) {
  const a = state.articles.find(x => x.id === id);
  if (a && a.link) window.open(a.link, '_blank', 'noopener');
}

/* ══ Mark All Read ════════════════════════════════════════════════════════════ */
async function markAllRead() {
  const feedId = state.activeFeed || undefined;
  try {
    const r = await POST('/api/mark-all-read', feedId ? { feedId } : {});
    showToast(`✓ Marked ${r.marked} articles read`, 'success');
    if (state.currentArticle) closeReader();
    await loadArticles();
  } catch { showToast('Error marking all read', 'warning'); }
}

/* ══ Refresh ══════════════════════════════════════════════════════════════════ */
async function refreshFeeds() {
  const btn = $('btnRefresh');
  btn.classList.add('spinning');
  try {
    await POST('/api/refresh');
    showToast('↻ Feeds refreshed', 'success');
    await loadArticles();
  } catch { showToast('Error refreshing', 'warning'); }
  finally { btn.classList.remove('spinning'); }
}

/* ══ Reader ══════════════════════════════════════════════════════════════════ */
function updateReaderToolbar() {
  const a = state.currentArticle;
  if (!a) return;
  const saveBtn   = $('readerSaveBtn');
  const unreadBtn = $('readerUnreadBtn');
  saveBtn.textContent = a.isSaved ? '🔖 Saved' : '🔖 Save';
  saveBtn.classList.toggle('active', a.isSaved);
  unreadBtn.textContent = a.isRead ? '↩ Unread' : '✓ Read';
}

function selectionOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

// Wrap each selected text fragment independently so highlights can span
// paragraphs and inline elements without using unsafe innerHTML.
function wrapHighlight(root, highlight) {
  if (!Number.isInteger(highlight.start) || !Number.isInteger(highlight.end)) return;
  let start = highlight.start;
  let end = highlight.end;
  const text = root.textContent || '';
  if (text.slice(start, end).trim() !== highlight.quote) {
    const fallback = text.indexOf(highlight.quote);
    if (fallback < 0) return;
    start = fallback;
    end = fallback + highlight.quote.length;
  }
  const nodes = textNodes(root);
  let cursor = 0;
  nodes.forEach(node => {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.nodeValue.length;
    cursor = nodeEnd;
    const from = Math.max(start, nodeStart) - nodeStart;
    const to = Math.min(end, nodeEnd) - nodeStart;
    if (to <= from) return;

    let target = node;
    if (to < target.nodeValue.length) target.splitText(to);
    if (from > 0) target = target.splitText(from);
    const mark = document.createElement('mark');
    mark.className = 'saved-highlight';
    mark.dataset.highlightId = highlight.id;
    mark.title = 'Saved highlight';
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  });
}

function renderHighlights(article) {
  if (!article || state.currentArticle?.id !== article.id) return;
  const body = $('articleBody');
  // Re-rendering the body is the source of truth; this also prevents nested
  // marks when the full-text request finishes after highlights load.
  (article.highlights || [])
    .slice()
    .sort((a, b) => b.start - a.start)
    .forEach(h => wrapHighlight(body, h));
}

async function loadHighlights(article) {
  if (!article || article.highlightsRequested) return;
  article.highlightsRequested = true;
  try {
    article.highlights = await GET(`/api/articles/${encodeURIComponent(article.id)}/highlights`);
    renderHighlights(article);
  } catch (err) {
    article.highlights = [];
    console.warn('Could not load highlights:', err);
  }
}

function hideHighlightPopover() {
  $('highlightPopover').classList.add('hidden');
  $('readerHighlightBtn').disabled = true;
}

function showHighlightPopover() {
  const selection = window.getSelection();
  if (!state.currentArticle || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    hideHighlightPopover();
    return;
  }
  const range = selection.getRangeAt(0);
  const body = $('articleBody');
  if (!body.contains(range.commonAncestorContainer)) {
    hideHighlightPopover();
    return;
  }
  const quote = selection.toString().trim();
  if (!quote) { hideHighlightPopover(); return; }
  // Keep the stored offsets aligned with the exact selected text. Trimming is
  // only for the display/API value, while the range remains the anchor.
  const rootText = body.textContent || '';
  const start = selectionOffset(body, range.startContainer, range.startOffset);
  const end = selectionOffset(body, range.endContainer, range.endOffset);
  state.pendingHighlight = {
    quote, start, end,
    prefix: rootText.slice(Math.max(0, start - 80), start),
    suffix: rootText.slice(end, end + 80),
  };
  // Put the action alongside the selected passage rather than below it, so the
  // association remains clear without pushing the reader's eye away from the text.
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] || range.getBoundingClientRect();
  const paneRect = $('readerPane').getBoundingClientRect();
  const popover = $('highlightPopover');
  const popoverWidth = 140;
  const popoverHeight = 34;
  const gap = 10;
  // The popover uses viewport-fixed coordinates. Clamp both axes to the reader
  // pane itself, which prevents it from ever crossing into the list column.
  const minLeft = paneRect.left + 8;
  const maxLeft = Math.max(minLeft, paneRect.right - popoverWidth - 8);
  const preferredRight = rect.right + gap;
  const left = preferredRight <= maxLeft
    ? preferredRight
    : Math.max(minLeft, rect.left - popoverWidth - gap);
  const top = Math.max(
    paneRect.top + 8,
    Math.min(paneRect.bottom - popoverHeight - 8, rect.top + rect.height / 2 - popoverHeight / 2)
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.classList.remove('hidden');
  $('readerHighlightBtn').disabled = false;
}

async function savePendingHighlight() {
  const article = state.currentArticle;
  const pending = state.pendingHighlight;
  if (!article || !pending) return;
  try {
    const highlight = await POST(`/api/articles/${encodeURIComponent(article.id)}/highlights`, pending);
    article.highlights = article.highlights || [];
    if (!article.highlights.some(h => h.id === highlight.id)) article.highlights.push(highlight);
    renderHighlights(article);
    window.getSelection()?.removeAllRanges();
    state.pendingHighlight = null;
    hideHighlightPopover();
    showToast('✦ Highlight saved');
  } catch { showToast('Error saving highlight', 'warning'); }
}

async function loadFullText(article) {
  if (!article || article.fullTextRequested) return;
  article.fullTextRequested = true;

  try {
    const fullText = await GET(`/api/articles/${encodeURIComponent(article.id)}/content`);
    article.fullContent = fullText.content || article.content || '';
    article.fullTextExtracted = Boolean(fullText.extracted);
    article.fullTextReason = fullText.reason || '';
    if (fullText.readingTime) article.readingTime = fullText.readingTime;
    if (fullText.author && !article.author) article.author = fullText.author;

    // The reader may have moved to another entry while the fetch was in flight.
    if (state.currentArticle?.id === article.id) openReader(article);
  } catch (err) {
    console.warn('Full-text extraction failed:', err);
    article.fullContent = article.content || '';
    article.fullTextExtracted = false;
  }
}

function openReader(article) {
  if (!article) return;
  state.currentArticle = article;

  /* ── Populate toolbar ── */
  $('readerFeedName').textContent   = article.feedTitle;
  $('readerReadingTime').textContent = `⏱ ${article.readingTime} min`;
  updateReaderToolbar();

  /* ── Populate article ── */
  $('articleTitle').textContent = article.title;

  const pubDate = article.pubDate
    ? new Date(article.pubDate).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
    : '';

  $('articleMeta').innerHTML = [
    `<a href="${escHtml(article.link)}" target="_blank" rel="noopener" class="article-feed-link">${escHtml(article.feedTitle)}</a>`,
    pubDate ? `<span class="meta-sep">·</span><time>${escHtml(pubDate)}</time>` : '',
    article.author ? `<span class="meta-sep">·</span><span>${escHtml(article.author)}</span>` : '',
    `<span class="meta-sep">·</span><span>${article.readingTime} min read</span>`,
  ].filter(Boolean).join('');

  const bodyHtml = sanitizeHtml(article.fullContent || article.content || '');
  const loadingNote = !article.fullTextRequested
    ? '<p class="full-text-loading">Loading full article…</p>'
    : '';
  const highlightsHtml = article.highlights?.length
    ? `<section class="saved-highlights"><h2>Highlights</h2>${article.highlights.map(h => `<blockquote>${escHtml(h.quote)}</blockquote>`).join('')}</section>`
    : '';
  $('articleBody').innerHTML = bodyHtml
    ? loadingNote + bodyHtml + highlightsHtml
    : highlightsHtml || `<p><a href="${escHtml(article.link)}" target="_blank" rel="noopener">Open original article ↗</a></p>`;
  renderHighlights(article);
  loadHighlights(article);

  /* ── Reset scroll / progress ── */
  readerScrollArea.scrollTop  = 0;
  readerProgressFill.style.width = '0%';

  /* ── Show content, hide empty state ── */
  $('readerEmpty').style.display   = 'none';
  $('readerContent').classList.remove('hidden');

  /* ── Nav buttons ── */
  const idx = state.articles.findIndex(a => a.id === article.id);
  $('readerPrev').disabled = idx <= 0;
  $('readerNext').disabled = idx >= state.articles.length - 1;

  /* ── Re-render list to update selected state ── */
  renderArticles();

  /* ── Auto-mark read and retrieve the publisher's full article ── */
  if (!article.isRead) markRead(article.id, true);
  loadFullText(article);
}

function closeReader() {
  state.currentArticle = null;
  $('readerEmpty').style.display   = '';
  $('readerContent').classList.add('hidden');
  renderArticles();
}

function navigateReader(dir) {
  const idx = state.articles.findIndex(a => a.id === state.currentArticle?.id);
  const next = idx + dir;
  if (next >= 0 && next < state.articles.length) {
    state.focusIdx = next;
    openReader(state.articles[next]);
  }
}

/* ══ Focus / keyboard navigation ═════════════════════════════════════════════ */
function moveFocus(dir) {
  const len = state.articles.length;
  if (!len) return;
  state.focusIdx = Math.max(0, Math.min(len - 1, state.focusIdx + dir));
  // Keyboard navigation continues naturally beyond the visible batch.
  if (state.focusIdx >= state.listLimit) {
    state.listLimit = Math.min(len, state.focusIdx + state.listChunk);
  }
  renderArticles();
  scrollFocusedIntoView();
}

function scrollFocusedIntoView() {
  const el = getFocusedEntryEl();
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ══ Scroll progress for reader ══════════════════════════════════════════════ */
readerScrollArea.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = readerScrollArea;
  const max = scrollHeight - clientHeight;
  const pct = max > 0 ? (scrollTop / max) * 100 : 0;
  readerProgressFill.style.width = pct + '%';
});

/* ══ Keyboard handler ═════════════════════════════════════════════════════════ */
function handleKey(e) {
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  /* Shortcuts overlay open */
  if (!$('shortcutsOverlay').classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      $('shortcutsOverlay').classList.add('hidden');
    }
    return;
  }

  /* Add Feed modal open */
  if (!$('modalOverlay').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    return;
  }

  /* Reader is showing an article */
  if (state.currentArticle) {
    if (e.key === 'Escape') { e.preventDefault(); closeReader(); return; }
    if (e.key === 'ArrowLeft'  || e.key === 'k') { e.preventDefault(); navigateReader(-1); return; }
    if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); navigateReader(1);  return; }
    if (e.key === 's') { e.preventDefault(); toggleSave(state.currentArticle.id); return; }
    if (e.key === 'o') { e.preventDefault(); openInBrowser(state.currentArticle.id); return; }
    if (e.key === 'r' || e.key === 'u') {
      e.preventDefault();
      const a = state.currentArticle;
      a.isRead ? markUnread(a.id) : markRead(a.id);
      return;
    }
    /* Allow j/k handled above, fall through for others */
    return;
  }

  const a = getFocusedArticle();

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      moveFocus(1);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      moveFocus(-1);
      break;
    case 'Enter':
      e.preventDefault();
      if (a) openReader(a);
      break;
    case 'Escape':
      e.preventDefault();
      if (state.activeFeed || state.activeGroup) {
        clearScope();
        syncNavActive();
        updateListTitle();
        renderFeeds();
        renderGroups();
        loadArticles();
      }
      break;
    case 'r':
      e.preventDefault();
      if (a) { a.isRead ? markUnread(a.id) : markRead(a.id); }
      break;
    case 'u':
      e.preventDefault();
      if (a && a.isRead) markUnread(a.id);
      break;
    case 's':
      e.preventDefault();
      if (a) toggleSave(a.id);
      break;
    case 'd':
      e.preventDefault();
      if (a) dismissAndRead(a.id);
      break;
    case 'o':
      e.preventDefault();
      if (a) openInBrowser(a.id);
      break;
    case 'm':
      e.preventDefault();
      markAllRead();
      break;
    case 'R':
      e.preventDefault();
      refreshFeeds();
      break;
    case 'x':
      e.preventDefault();
      toggleSprint();
      break;
    case '/':
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      break;
    case '1':
      e.preventDefault();
      setFilter('all');
      break;
    case '2':
      e.preventDefault();
      setFilter('unread');
      break;
    case '3':
      e.preventDefault();
      setFilter('saved');
      break;
    case '?':
      e.preventDefault();
      $('shortcutsOverlay').classList.remove('hidden');
      break;
  }
}

/* ══ Filter helpers ══════════════════════════════════════════════════════════ */
// A feed/group selection is a scope on top of the filter. Clearing the scope
// lets the plain filter buttons (All / Unread / Saved) show everything again.
function clearScope() {
  state.activeFeed = null;
  state.activeCategory = null;
  state.activeGroup = null;
}

// The filter nav is only "active" when no feed/group scope is selected.
function syncNavActive() {
  document.querySelectorAll('[data-filter]').forEach(b => {
    b.classList.toggle('active', !state.activeFeed && !state.activeGroup && b.dataset.filter === state.filter);
  });
}

function setFilter(f) {
  state.filter = f;
  clearScope();
  syncNavActive();
  renderFeeds();
  renderGroups();
  updateListTitle();
  loadArticles();
}

/* ══ Modal ════════════════════════════════════════════════════════════════════ */
function openModal() {
  $('feedUrlInput').value      = '';
  $('feedCategoryInput').value = 'general';
  const statusEl = $('modalStatus');
  statusEl.className   = 'modal-status hidden';
  statusEl.textContent = '';
  $('modalSubmit').disabled = false;
  $('modalOverlay').classList.remove('hidden');
  setTimeout(() => $('feedUrlInput').focus(), 100);
}

function closeModal() {
  $('modalOverlay').classList.add('hidden');
}

function showStatus(msg, type) {
  const statusEl = $('modalStatus');
  statusEl.className   = 'modal-status ' + (type || '');
  statusEl.textContent = msg;
}

async function submitAddFeed() {
  const url      = $('feedUrlInput').value.trim();
  const category = $('feedCategoryInput').value.trim() || 'general';
  if (!url) { showStatus('Please enter a URL', 'error'); return; }

  const statusEl  = $('modalStatus');
  const submitBtn = $('modalSubmit');
  statusEl.className   = 'modal-status';
  statusEl.textContent = '⏳ Fetching feed…';
  submitBtn.disabled   = true;

  try {
    const feed = await POST('/api/feeds', { url, category });
    statusEl.className   = 'modal-status success';
    statusEl.textContent = `✓ Added "${feed.title}"`;
    submitBtn.disabled   = false;
    state.feeds.push(feed);
    buildFeedUrlMap();
    renderFeeds();
    await loadArticles();
    setTimeout(closeModal, 1000);
  } catch (err) {
    statusEl.className   = 'modal-status error';
    statusEl.textContent = err.message.includes('409')
      ? '⚠ Feed already added'
      : '✗ Failed to fetch feed';
    submitBtn.disabled = false;
  }
}

/* ══ AI feed organization ════════════════════════════════════════════════════ */
async function autoCategorizeFeeds() {
  const btn = $('btnOrganizeFeeds');
  btn.disabled = true;
  btn.textContent = '✦ Organizing…';
  try {
    const result = await POST('/api/feeds/auto-categorize');
    const freshFeeds = await GET('/api/feeds');
    state.feeds = freshFeeds;
    buildFeedUrlMap();
    renderFeeds();
    showToast(`✦ Grouped ${result.updated} feeds into ${result.categories.length} categories`, 'success');
  } catch (err) {
    showToast(err.message.includes('503')
      ? 'Configure AI_API_KEY to use AI organization'
      : 'AI organization failed', 'warning');
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ AI organize';
  }
}

async function autoGroupArticles() {
  const btn = $('btnGroupArticles');
  btn.disabled = true;
  btn.textContent = '✦ Grouping…';
  try {
    const result = await POST('/api/groups/auto');
    await loadGroups();
    showToast(`✦ Grouped ${result.grouped} articles`, 'success');
  } catch (err) {
    showToast(err.message.includes('503') ? 'Configure AI_API_KEY to use AI grouping' : 'AI grouping failed', 'warning');
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ AI group';
  }
}

/* ══ Delete feed ══════════════════════════════════════════════════════════════ */
async function deleteFeed(id) {
  try {
    await DELETE(`/api/feeds/${id}`);
    state.feeds = state.feeds.filter(f => f.id !== id);
    buildFeedUrlMap();
    if (state.activeFeed === id) {
      state.activeFeed = null;
      syncNavActive();
      updateListTitle();
    }
    if (state.currentArticle && state.currentArticle.feedId === id) {
      closeReader();
    }
    showToast('Feed removed');
    renderFeeds();
    await loadArticles();
  } catch { showToast('Error removing feed', 'warning'); }
}

/* ══ Wire up events ══════════════════════════════════════════════════════════ */
function wireEvents() {
  /* Keyboard */
  document.addEventListener('keydown', handleKey);

  /* Theme buttons */
  document.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeBtn));
  });

  /* Auto theme: respond to OS changes */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('theme') || 'auto') === 'auto') applyTheme('auto');
  });

  /* Filter nav buttons */
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });

  /* Sort select */
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    loadArticles();
  });

  /* Search (debounced 300ms) */
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value.trim();
      loadArticles();
    }, 300);
  });

  /* Article list – event delegation */
  articleList.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn?.dataset.action === 'show-more') {
      state.listLimit = Math.min(state.articles.length, state.listLimit + state.listChunk);
      renderArticles();
      return;
    }
    if (actionBtn?.dataset.action === 'show-all') {
      state.listLimit = state.articles.length;
      renderArticles();
      return;
    }

    /* Save button */
    const saveBtn = e.target.closest('[data-action="save"]');
    if (saveBtn) {
      e.stopPropagation();
      toggleSave(saveBtn.dataset.id);
      return;
    }

    /* Entry row click → open reader */
    const entry = e.target.closest('.entry');
    if (entry) {
      const idx = parseInt(entry.dataset.idx, 10);
      state.focusIdx = idx;
      const a = state.articles[idx];
      if (a) openReader(a);
    }
  });

  /* Update focus index on mouse hover */
  articleList.addEventListener('mouseover', e => {
    const entry = e.target.closest('.entry');
    if (entry) {
      const idx = parseInt(entry.dataset.idx, 10);
      if (!isNaN(idx)) {
        state.focusIdx = idx;
        document.querySelectorAll('.entry.focused').forEach(el => el.classList.remove('focused'));
      }
    }
  });

  /* Feed list – event delegation */
  feedList.addEventListener('click', e => {
    const del = e.target.closest('[data-delete-feed]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.deleteFeed;
      const f  = state.feeds.find(x => x.id === id);
      if (f && confirm(`Remove "${f.title}"?`)) deleteFeed(id);
      return;
    }
    const item = e.target.closest('.feed-item');
    if (item) {
      const id = item.dataset.feedId;
      const wasActive = state.activeFeed === id;
      clearScope();
      state.activeFeed = wasActive ? null : id;
      // Selecting a feed shows its unread articles; the filter nav steps aside.
      if (state.activeFeed) state.filter = 'unread';
      syncNavActive();
      renderFeeds();
      renderGroups();
      updateListTitle();
      loadArticles();
    }
  });

  /* Add feed */
  $('btnAddFeed').addEventListener('click', openModal);
  $('btnOrganizeFeeds').addEventListener('click', autoCategorizeFeeds);
  $('btnGroupArticles').addEventListener('click', autoGroupArticles);
  groupList.addEventListener('click', e => {
    const item = e.target.closest('[data-group]');
    if (!item) return;
    state.activeGroup = state.activeGroup === item.dataset.group ? null : item.dataset.group;
    state.activeFeed = null;
    state.activeCategory = null;
    syncNavActive();
    renderGroups();
    renderFeeds();
    updateListTitle();
    loadArticles();
  });
  $('modalClose').addEventListener('click', closeModal);
  $('modalCancel').addEventListener('click', closeModal);
  $('modalOverlay').addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });
  $('modalSubmit').addEventListener('click', submitAddFeed);
  $('feedUrlInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitAddFeed(); });

  /* Suggested chips */
  const chipsEl = $('suggestedChips');
  SUGGESTED.forEach(s => {
    const chip = document.createElement('button');
    chip.className   = 'suggested-chip';
    chip.textContent = s.label;
    chip.addEventListener('click', () => {
      $('feedUrlInput').value = s.url;
      $('feedUrlInput').focus();
    });
    chipsEl.appendChild(chip);
  });

  /* Reader toolbar buttons */
  $('readerUnreadBtn').addEventListener('click', () => {
    const a = state.currentArticle;
    if (a) { a.isRead ? markUnread(a.id) : markRead(a.id); }
  });

  $('readerSaveBtn').addEventListener('click', () => {
    if (state.currentArticle) toggleSave(state.currentArticle.id);
  });

  $('readerHighlightBtn').addEventListener('click', savePendingHighlight);
  $('highlightSelectionBtn').addEventListener('click', savePendingHighlight);
  $('readerScrollArea').addEventListener('mouseup', () => setTimeout(showHighlightPopover, 0));
  $('readerScrollArea').addEventListener('keyup', showHighlightPopover);
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#highlightPopover') && !e.target.closest('#readerHighlightBtn')) hideHighlightPopover();
  });

  $('readerOpenBtn').addEventListener('click', () => {
    if (state.currentArticle) openInBrowser(state.currentArticle.id);
  });

  $('readerPrev').addEventListener('click', () => navigateReader(-1));
  $('readerNext').addEventListener('click', () => navigateReader(1));

  /* Toolbar / list pane */
  $('btnRefresh').addEventListener('click', refreshFeeds);
  $('btnMarkAllRead').addEventListener('click', markAllRead);

  /* Sprint */
  $('btnSprintSidebar').addEventListener('click', toggleSprint);
  $('btnSprintStop').addEventListener('click', toggleSprint);

  /* Celebration */
  $('celebrationAnother').addEventListener('click', () => {
    hideCelebration();
    state.sprintMode  = true;
    state.sprintCount = 0;
    updateSprintBanner();
    showToast('⚡ Sprint started!');
  });
  $('celebrationDone').addEventListener('click', hideCelebration);

  /* Shortcuts overlay */
  $('btnShortcuts').addEventListener('click', () => $('shortcutsOverlay').classList.remove('hidden'));
  $('shortcutsClose').addEventListener('click', () => $('shortcutsOverlay').classList.add('hidden'));
  $('shortcutsOverlay').addEventListener('click', e => {
    if (e.target === $('shortcutsOverlay')) $('shortcutsOverlay').classList.add('hidden');
  });

  /* Empty state "View all" */
  $('btnViewAll').addEventListener('click', () => setFilter('all'));
}

/* ══ Init ═════════════════════════════════════════════════════════════════════ */
async function init() {
  /* Restore visual preferences before loading content. */
  loadTheme();
  restorePaneWidths();

  /* Wire all events */
  wireEvents();
  setupColumnResizers();

  /* Show loading */
  loadingState.classList.remove('hidden');

  /* Load feeds */
  try {
    state.feeds = await GET('/api/feeds');
  } catch { state.feeds = []; }

  buildFeedUrlMap();
  renderFeeds();
  await loadGroups();

  /* Load articles */
  await loadArticles(true);

  /* Auto-refresh every 5 min */
  setInterval(() => loadArticles(), 5 * 60 * 1000);
}

init();
