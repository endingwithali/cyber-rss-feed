# ⚡ FocusFeed — ADHD RSS Reader

A distraction-free RSS reader built for ADHD brains. Fast keyboard navigation, sprint mode, a Feedbin-inspired light/dark interface, and a calm reading environment that keeps you focused without anxiety. Opening an article attempts to retrieve and extract the publisher page's full main body, with a graceful fallback to the RSS-provided content.

## Requirements

- **Node.js 18 or newer** (the server uses Node's built-in `fetch` API)
- **npm** (included with Node.js)
- Network access to the RSS feed URLs in `data/feeds.json`
- A modern web browser

No database or separate frontend build step is required. The Express server serves the files in `public/` directly and stores local reading state in `data/state.json`.

## Run locally

From the project directory:

```bash
# Install dependencies
npm install

# Start the local server
npm start
```

Open **http://localhost:3000** in your browser. On startup, the server begins fetching the configured feeds in the background; the first article list may take a few seconds to appear. Use the **Refresh** action in the app, or `POST /api/refresh`, to fetch them again.

For automatic server restarts while developing, use:

```bash
npm run dev
```

To use a different port:

```bash
PORT=4000 npm start
# → http://localhost:4000
```

## Features

- **Sprint mode** — commit to 3 articles, get a 🎉 celebration on completion
- **Keyboard-first** — navigate everything without touching the mouse
- **Reading time** — every card shows "2 min read" so you can pick your battles
- **Dismiss animation** — satisfying slide-away when marking read
- **Full-text reader** — opening an article extracts the publisher page's main body when available, with an RSS-content fallback and scroll progress bar
- **Saved highlights** — select text in the reader and save it; highlights persist across sessions
- **Mark all read** — one click to clear the overwhelm
- **Non-anxious counts** — unread counts in muted styling, no red badges
- **Auto-refresh** — feeds refresh every 30 minutes automatically
- **Color-coded feeds** — each feed has its own color accent strip
- **AI feed organization** — group feeds into broad categories with an OpenAI-compatible model
- **AI topic grouping** — cluster the latest cached articles by shared topic

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / `↓` | Next article |
| `k` / `↑` | Prev article |
| `Enter` | Open reader |
| `Esc` | Close / back |
| `r` | Mark read / unread (toggle) |
| `u` | Mark unread |
| `s` | Save / unsave |
| `d` | Dismiss + next |
| `o` | Open in browser |
| `m` | Mark all read |
| `1` / `2` / `3` | Switch filter (Unread / Saved / All) |
| `R` | Refresh feeds |
| `x` | Toggle sprint mode |
| `/` | Focus search |
| `?` | Keyboard shortcuts help |

## API Endpoints

```
GET    /api/feeds                   List all feeds
POST   /api/feeds                   Add feed { url, category }
DELETE /api/feeds/:id               Remove feed

GET    /api/articles                List articles (filter, feed, category, search, sort)
GET    /api/articles/:id/content    Extract and cache the publisher page's main article body
POST   /api/articles/:id/read       Mark read
POST   /api/articles/:id/unread     Mark unread
POST   /api/articles/:id/save       Save
POST   /api/articles/:id/unsave     Unsave
GET    /api/articles/:id/highlights List saved highlights
POST   /api/articles/:id/highlights Save a text highlight
DELETE /api/articles/:id/highlights/:highlightId Remove a highlight

POST   /api/refresh                 Force refresh all feeds
POST   /api/mark-all-read           Mark all (or one feed's) articles read
GET    /api/stats                   Reading stats
GET    /api/groups                  List AI-created article topic groups
POST   /api/groups/auto             Group up to 500 cached articles with AI
POST   /api/feeds/auto-categorize   Categorize all feeds with AI
```

## Data and feed configuration

- `data/feeds.json` — the RSS feed list. Edit this file to add or remove feeds before starting the server, or add feeds from the app.
- `data/state.json` — read, saved, and highlight state. Created and updated automatically; it is local runtime data and is ignored by Git.
- `data/groups.json` — AI-generated article topic assignments. Created only when topic grouping is used and ignored by Git.

The server needs outbound network access to refresh feeds and to retrieve full article text. Feed failures are logged by the server and do not prevent the app from starting.

## Optional AI features

Feed categorization and article topic grouping require an API key for an OpenAI-compatible chat-completions service. AI features are disabled when no key is configured. Set the variables in the shell that launches the server:

```bash
AI_API_KEY=your-key npm start
```

Optional settings:

- `AI_API_URL` — chat-completions endpoint; defaults to `https://api.openai.com/v1/chat/completions`
- `AI_MODEL` — model name; defaults to `gpt-4o-mini`

You can also export the values before starting the server:

```bash
export AI_API_KEY=your-key
export AI_API_URL=https://api.openai.com/v1/chat/completions
export AI_MODEL=gpt-4o-mini
npm start
```

`.env.example` lists the supported variables. The server reads environment variables supplied by the process; it does not load a `.env` file automatically. Never commit real credentials. Feed organization sends feed titles and URLs to the configured service. Article grouping sends up to 500 cached article titles, feed names, and short excerpts. No API key is stored in the repository.
