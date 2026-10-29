# Outlier Board — YouTube Research Tool Abstraction

> Reverse-engineered from a live demo in "The Creator Who Mastered Claude"
> (The Calum Johnson Show × KJ Rainey, Oct 19 2026, 117K views)
> Video: https://youtu.be/Yt_BULiimg4

---

## 1. What It Is

**Outlier Board** is a web application that lets YouTube creators search for,
analyze, and save "outlier" videos — videos whose view count far exceeds what
the channel's subscriber base would predict. It replaces the manual workflow
of browsing YouTube, checking analytics, and keeping spreadsheets of
interesting videos.

**Live URL**: `outlier-board.vercel.app` (Vercel-hosted)
**Built with**: Claude Cowork (AI pair-programming approach)
**Target user**: YouTube creators doing competitive research

---

## 2. Origin Story & Problem Statement

KJ Rainey's prompt framework (from his Miro planning board):

1. **Why am I building this thing?** ("magic word")
   - To research competing/trending videos around topics I make content about
   - A friend said "Dude, I need somewhere where I can save outliers"

2. **What's wrong with the current way of doing?**
   - YouTube search doesn't show outlier metrics
   - Using multiple tools (YouTube, third-party analytics) is fragmented
   - Can't save/organize outlier videos into a clean list
   - Can't search by plain interest words — forced to use exact keywords

3. **What's the exact outcome, features, & functionality I want?**
   - Search by topic/keyword → see results with details (published date, views)
   - Show key metadata prominently on each video card
   - Filter by duration (longs vs shorts)
   - Save search results and filter configurations
   - Use natural/plain words, not just exact keyword matches

4. **How will I get the data?**
   - YouTube Data API v3 from Google (primary recommendation)

---

## 3. Feature Breakdown

### 3.1 Core: Search & Discovery

| Feature | Description |
|---------|-------------|
| **Keyword Search** | Search YouTube by topic, keyword, or plain words |
| **Natural Language** | Supports interest-based queries, not just exact keywords |
| **Results Grid** | Displays matching videos as thumbnail cards in a grid |
| **YouTube URL Input** | Paste any YouTube URL to analyze and add directly |

### 3.2 Core: Outlier Detection

| Feature | Description |
|---------|-------------|
| **Outlier Score** | Compares video views against channel subscriber count |
| **Big Outlier** | Video views far exceed the channel's subscriber count |
| **Mid Outlier** | Video moderately outperforms expected view count |
| **No Outlier** | Video performs as expected for the channel size |
| **Color-coded Badges** | Visual pills on each card showing outlier classification |

**Outlier Calculation** (inferred):
```
outlier_ratio = video_views / channel_subscribers

if outlier_ratio > HIGH_THRESHOLD → "Big Outlier" (green badge)
if outlier_ratio > MID_THRESHOLD  → "Mid Outlier" (yellow badge)
else                              → "No Outlier"  (neutral badge)
```

### 3.3 Save & Organize

| Feature | Description |
|---------|-------------|
| **Add to Board** | Red "Add to Board" button to save any video |
| **Personal Notes** | Text area to attach notes to each saved video |
| **Board View** | Saved videos displayed as a persistent collection |
| **Search Board** | Search saved videos by title, channel name, or notes |

### 3.4 Filter & Sort

| Feature | Description |
|---------|-------------|
| **Sort: Recent First** | Sort by most recently added or published |
| **Sort: Long → Shorts** | Sort by video duration (longest first) |
| **Filter: Outlier Tier** | Show only Big / Mid / No outlier videos |
| **Filter: Data Available** | Show only videos with full analytics data |
| **Filter: By Date** | Filter by publish date range |

### 3.5 Video Card Data Model

Each video card displays:

```
┌─────────────────────────────────┐
│  [Thumbnail Image]              │
│                                 │
│  Video Title                    │
│  Channel Name                   │
│  ┌──────────┐ ┌──────────────┐  │
│  │ 245K views│ │ 12.3K subs  │  │
│  └──────────┘ └──────────────┘  │
│  ┌──────────────┐               │
│  │ BIG OUTLIER  │  (color pill) │
│  └──────────────┘               │
│  Published: Oct 15, 2026        │
│  Duration: 12:34                │
└─────────────────────────────────┘
```

---

## 4. Architecture (Abstracted)

### 4.1 System Diagram

```
┌──────────────────────────────────────────────────────────┐
│                      FRONTEND                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Search Bar (keyword / natural language / URL)     │  │
│  ├────────────────────────────────────────────────────┤  │
│  │  Filter Bar (outlier tier, duration, date, search) │  │
│  ├────────────────────────────────────────────────────┤  │
│  │  Video Card Grid (thumbnail, title, channel,       │  │
│  │    views, subs, outlier badge, duration, date)     │  │
│  ├────────────────────────────────────────────────────┤  │
│  │  Add to Board + Notes Panel                        │  │
│  └────────────────────────────────────────────────────┘  │
│              Vercel-hosted (Next.js / React)              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                      BACKEND                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  YouTube API  │  │  Outlier     │  │  User Data   │   │
│  │  v3 Client    │  │  Calculator  │  │  Store       │   │
│  │              │  │              │  │  (boards,    │   │
│  │  - search    │  │  - fetch     │  │   notes,     │   │
│  │  - videos    │  │    channel   │  │   saved      │   │
│  │  - channels  │  │    stats     │  │   searches)  │   │
│  │              │  │  - compute   │  │              │   │
│  │              │  │    ratio     │  │              │   │
│  │              │  │  - classify  │  │              │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Data Flow

```
User enters search term or pastes URL
        │
        ▼
YouTube Data API v3: search.list(q=term, type=video)
        │
        ▼
For each video result:
  ├── videos.list(id=videoId) → views, duration, publishDate
  └── channels.list(id=channelId) → subscriberCount
        │
        ▼
Outlier Calculation:
  ratio = views / subscribers
  tier  = classify(ratio)
        │
        ▼
Render cards with outlier badge
        │
        ▼
User can: filter, sort, add to board, add notes
```

### 4.3 Technology Stack (Inferred)

| Layer | Technology |
|-------|-----------|
| **Frontend** | React or Next.js (Vercel deployment) |
| **Hosting** | Vercel |
| **Data Source** | YouTube Data API v3 |
| **Auth** | Likely Vercel Auth or Clerk (for saved boards) |
| **Database** | Likely Supabase, PlanetScale, or Vercel KV |
| **Styling** | Dark theme, likely Tailwind CSS |

---

## 5. API Requirements

### 5.1 YouTube Data API v3 Endpoints Needed

```
GET youtube/v3/search
  ?q={searchTerm}
  &type=video
  &part=snippet
  &maxResults=50
  &relevanceLanguage=en
  → returns: videoId, title, channelId, thumbnail, publishedAt

GET youtube/v3/videos
  ?id={videoId1,videoId2,...}
  &part=statistics,contentDetails
  → returns: viewCount, likeCount, duration

GET youtube/v3/channels
  ?id={channelId1,channelId2,...}
  &part=statistics
  → returns: subscriberCount
```

### 5.2 Internal API (Backend)

```
POST /api/search        → search YouTube, compute outliers, return cards
POST /api/board/add     → save video + notes to user's board
GET  /api/board         → retrieve user's saved videos
PUT  /api/board/:id     → update notes on a saved video
DELETE /api/board/:id   → remove video from board
GET  /api/board/search  → search within saved board (title/channel/notes)
POST /api/analyze-url   → analyze a pasted YouTube URL directly
```

---

## 6. Outlier Detection Algorithm

### 6.1 Core Formula

```javascript
function classifyOutlier(videoViews, channelSubscribers) {
  if (!channelSubscribers || channelSubscribers === 0) {
    return { tier: 'unknown', ratio: null };
  }

  const ratio = videoViews / channelSubscribers;

  if (ratio >= 10)  return { tier: 'big',  ratio, label: 'Big Outlier' };
  if (ratio >= 3)   return { tier: 'mid',  ratio, label: 'Mid Outlier' };
  return               { tier: 'none', ratio, label: 'No Outlier' };
}
```

### 6.2 What Makes a Video an "Outlier"

An "outlier" is a video that breaks the expected performance pattern for its
channel. A channel with 10K subscribers averaging 5K views per video that
suddenly gets 500K views on one video — that video is a **Big Outlier**.

This matters to creators because:
- **Outlier titles/topics reveal what audiences actually want**
- **Outlier thumbnails show what's clickable in that niche**
- **Studying outliers = studying proven demand signals**

---

## 7. UI/UX Specification

### 7.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│  🔴 Outlier Board                          [user] [log] │
│  "I found N videos more seen than the channel's subs"   │
├─────────────────────────────────────────────────────────┤
│  [Paste a YouTube URL here...              ] [KJ] [Add] │
│  [+ add note                                          ] │
├─────────────────────────────────────────────────────────┤
│  Search titles, channels, notes...                      │
│  [All] [Recent] [By date] [Big outlier] [Mid] [None]    │
│                                    Recent First ▾  L>S  │
├─────────────────────────────────────────────────────────┤
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │
│  │ 📹  │ │ 📹  │ │ 📹  │ │ 📹  │ │ 📹  │             │
│  │Title│ │Title│ │Title│ │Title│ │Title│             │
│  │Chan │ │Chan │ │Chan │ │Chan │ │Chan │             │
│  │Stats│ │Stats│ │Stats│ │Stats│ │Stats│             │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘             │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                      │
│  │ 📹  │ │ 📹  │ │ 📹  │ │ 📹  │                      │
│  └─────┘ └─────┘ └─────┘ └─────┘                      │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Design Notes
- **Dark theme** (dark background, light text)
- **Red/coral accent color** (icon, Add button)
- **Color-coded outlier badges** (green = big, yellow = mid, neutral = none)
- **Responsive grid** (5 columns on desktop, fewer on mobile)
- **Video thumbnails** are the primary visual element

---

## 8. Implementation Outline

### Phase 1: Core Search & Display
1. Set up Next.js project on Vercel
2. Integrate YouTube Data API v3 (search + video stats + channel stats)
3. Build search bar component (keyword input)
4. Build video card component (thumbnail, title, channel, views, subs)
5. Implement outlier ratio calculation
6. Add outlier badge to video cards (Big / Mid / None)

### Phase 2: Save & Organize
7. Add user authentication (Clerk or NextAuth)
8. Set up database (Supabase or PlanetScale)
9. Implement "Add to Board" functionality
10. Add notes field per saved video
11. Build board view (saved videos page)

### Phase 3: Filter & Sort
12. Add search within saved board (titles, channels, notes)
13. Implement sort options (recent first, duration)
14. Add filter chips (outlier tier, date range, duration)
15. Build "Long > Shorts" duration toggle

### Phase 4: Polish
16. URL paste-to-analyze (bypass search, analyze directly)
17. Natural language search enhancement
18. Responsive design & dark theme
19. Share board / export functionality

---

## 9. Key Takeaway: KJ's Prompt Framework

KJ's approach to building tools with Claude follows a **4-question framework**
(written on his Miro planning board before touching code):

| Step | Question | Purpose |
|------|----------|---------|
| 1 | **Why am I building this?** | Grounds the motivation (he calls this the "magic word") |
| 2 | **What's wrong with the current way?** | Defines the pain point Claude needs to solve |
| 3 | **What's the exact outcome, features & functionality?** | Creates a concrete spec |
| 4 | **How will I get the data?** (optional) | Specifies API/connector/browser to use |

This framework is then written as a **Starting Prompt** and given to Claude
in a Cowork session, where Claude builds the entire tool iteratively.

---

## 10. Adaptation Notes for Chandra-FRAYMUS

To build a similar tool within the Chandra ecosystem:

- **YouTube Data API** → wire as an MCP tool or HTTP tool in the Hermes fleet
- **Outlier calculation** → implement as a Vertiso-aware agent skill
- **Board/save** → store in Vertiso vector memory with embeddings for semantic search
- **Search** → use Vertiso's semantic recall instead of simple text matching
- **Agent integration** → a "YouTubeResearch" agent in the fleet that can
  search, classify outliers, and save findings with memory context
- **RSI improvement** → the agent can evolve its outlier thresholds over time
  based on which saved videos the user actually references later
