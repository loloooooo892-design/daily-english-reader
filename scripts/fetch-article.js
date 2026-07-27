import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import RSSParser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FEEDS_PATH = join(ROOT, "data", "feeds.json");
const HISTORY_PATH = join(ROOT, "data", "history.json");
const ARTICLE_PATH = join(ROOT, "data", "today.json");
const MIN_WORDS = 500;
const MAX_WORDS = 1500;
const CATEGORIES = ["tech", "law", "gaming", "fun"];
const ALLOWED_TAGS = new Set(["p", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "em", "strong", "a"]);
const TIMEOUT_MS = 3 * 60 * 1000;

const startTime = Date.now();

function elapsed() {
  return Date.now() - startTime;
}

function isTimedOut() {
  return elapsed() > TIMEOUT_MS - 15000;
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { recent: [], categoryLog: [], failures: {} };
  const h = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
  if (!h.failures) h.failures = {};
  return h;
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function pickCategory(history) {
  const last7 = history.categoryLog.slice(-6);
  const missing = CATEGORIES.filter((c) => !last7.includes(c));
  if (missing.length > 0) {
    return missing[Math.floor(Math.random() * missing.length)];
  }
  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHtml(html) {
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<img[^>]*>/gi, "");
  html = html.replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, "");
  html = html.replace(/<picture[^>]*>[\s\S]*?<\/picture>/gi, "");
  html = html.replace(/<video[^>]*>[\s\S]*?<\/video>/gi, "");
  html = html.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");

  html = html.replace(/<\/?([\w-]+)([^>]*)>/g, (match, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return "";
    if (t === "a") {
      const href = attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i);
      if (href) return match.startsWith("</") ? `</${t}>` : `<${t} href="${href[1]}" target="_blank" rel="noopener">`;
      return match.startsWith("</") ? `</${t}>` : `<${t}>`;
    }
    return match.startsWith("</") ? `</${t}>` : `<${t}>`;
  });

  html = html.replace(/(<(p|blockquote|li|h[2-4])>\s*<\/(p|blockquote|li|h[2-4])>)/gi, "");
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

async function fetchFeed(feedInfo) {
  const parser = new RSSParser({ timeout: 15000 });
  try {
    const feed = await parser.parseURL(feedInfo.url);
    return feed.items.map((item) => ({
      title: item.title,
      link: item.link,
      date: item.pubDate || item.isoDate,
      source: feedInfo.name,
    }));
  } catch {
    console.warn(`  Failed to fetch feed: ${feedInfo.name}`);
    return [];
  }
}

async function extractArticle(url) {
  try {
    const article = await extract(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!article || !article.content) return null;
    const cleanContent = sanitizeHtml(article.content);
    const plainText = stripHtml(cleanContent);
    const wordCount = countWords(plainText);
    return { ...article, content: cleanContent, plainText, wordCount };
  } catch {
    return null;
  }
}

const BUFFER_PATH = join(ROOT, "data", "buffer.json");

function loadBuffer() {
  if (!existsSync(BUFFER_PATH)) return [];
  try {
    return JSON.parse(readFileSync(BUFFER_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveBuffer(buffer) {
  writeFileSync(BUFFER_PATH, JSON.stringify(buffer, null, 2));
}

function addToBuffer(article) {
  const buffer = loadBuffer();
  if (buffer.some((a) => a.url === article.url)) return;
  buffer.push(article);
  if (buffer.length > 10) buffer.shift();
  saveBuffer(buffer);
}

function popFromBuffer(history) {
  const buffer = loadBuffer();
  const idx = buffer.findIndex((a) => !history.recent.includes(a.url));
  if (idx === -1) return null;
  const [article] = buffer.splice(idx, 1);
  saveBuffer(buffer);
  return article;
}

const TARGET_ARTICLES = 4;

async function collectFromCategory(category, feeds, history, collected, max) {
  const categoryFeeds = feeds[category];
  if (!categoryFeeds || categoryFeeds.length === 0) return [];

  const shuffled = [...categoryFeeds].sort(() => Math.random() - 0.5);
  const collectedUrls = new Set(collected.map((a) => a.url));

  let allItems = [];
  for (const feed of shuffled) {
    if (isTimedOut()) break;
    const items = await fetchFeed(feed);
    allItems.push(...items);
  }

  allItems = allItems
    .filter((item) => !history.recent.includes(item.link) && !collectedUrls.has(item.link))
    .sort(() => Math.random() - 0.5);

  console.log(`  Found ${allItems.length} candidates in "${category}"`);

  const results = [];
  let relaxed = false;
  for (const item of allItems) {
    if (isTimedOut() || results.length >= max) break;

    console.log(`  Trying: ${item.title} (${item.source})`);
    const article = await extractArticle(item.link);
    if (!article) {
      console.log("    -> extraction failed");
      continue;
    }
    console.log(`    -> ${article.wordCount} words`);

    const inRange = article.wordCount >= MIN_WORDS && article.wordCount <= MAX_WORDS;
    const closeEnough =
      relaxed && article.wordCount >= MIN_WORDS * 0.6 && article.wordCount <= MAX_WORDS * 1.5;

    if (inRange || closeEnough) {
      results.push({
        title: article.title || item.title,
        source: item.source,
        author: article.author || null,
        url: item.link,
        date: item.date,
        category,
        wordCount: article.wordCount,
        content: article.content,
        fetchedAt: new Date().toISOString(),
      });
      collectedUrls.add(item.link);
      continue;
    }

    if (article.wordCount >= MIN_WORDS * 0.5 && article.wordCount <= MAX_WORDS * 2) {
      addToBuffer({
        title: article.title || item.title,
        source: item.source,
        author: article.author || null,
        url: item.link,
        date: item.date,
        category,
        wordCount: article.wordCount,
        content: article.content,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (allItems.indexOf(item) > allItems.length * 0.7 && !relaxed) {
      console.log("    -> relaxing word count filter");
      relaxed = true;
    }
  }

  return results;
}

async function run() {
  const feeds = JSON.parse(readFileSync(FEEDS_PATH, "utf-8"));
  const history = loadHistory();
  const primaryCategory = pickCategory(history);
  const failedCategories = [];
  let articles = [];

  console.log(`Primary category: ${primaryCategory}`);

  // Collect from primary category
  const primaryResults = await collectFromCategory(primaryCategory, feeds, history, articles, TARGET_ARTICLES);
  articles.push(...primaryResults);
  console.log(`\nGot ${primaryResults.length} from "${primaryCategory}"`);

  if (primaryResults.length === 0) {
    failedCategories.push(primaryCategory);
    history.failures[primaryCategory] = (history.failures[primaryCategory] || 0) + 1;
  }

  // Fill remaining slots from other categories
  if (articles.length < TARGET_ARTICLES && !isTimedOut()) {
    const others = CATEGORIES.filter((c) => c !== primaryCategory).sort(() => Math.random() - 0.5);
    for (const cat of others) {
      if (isTimedOut() || articles.length >= TARGET_ARTICLES) break;
      console.log(`\nFilling from "${cat}"...`);
      const more = await collectFromCategory(cat, feeds, history, articles, TARGET_ARTICLES - articles.length);
      articles.push(...more);
      console.log(`Got ${more.length} from "${cat}" (total: ${articles.length})`);
      if (more.length === 0) {
        failedCategories.push(cat);
        history.failures[cat] = (history.failures[cat] || 0) + 1;
      }
    }
  }

  // Supplement from buffer if still short
  if (articles.length === 0) {
    console.log("\nNo articles found, trying buffer...");
    const buffered = popFromBuffer(history);
    if (buffered) {
      buffered.fetchedAt = new Date().toISOString();
      articles.push(buffered);
      console.log(`Used buffered: "${buffered.title}"`);
    }
  }

  if (articles.length === 0) {
    console.error("\nNo article found from any source or buffer.");
    process.exit(1);
  }

  if (failedCategories.length > 0) {
    articles[0].failedCategories = failedCategories;
  }

  // Save all articles (array format)
  writeFileSync(ARTICLE_PATH, JSON.stringify(articles, null, 2));

  // Update history with all collected articles
  history.categoryLog = [...history.categoryLog.slice(-13), primaryCategory];
  for (const a of articles) {
    history.recent = [...history.recent.slice(-50), a.url];
  }
  delete history.failures[primaryCategory];
  saveHistory(history);

  console.log(`\nCollected ${articles.length} articles:`);
  articles.forEach((a, i) => console.log(`  ${i + 1}. "${a.title}" (${a.wordCount}w, ${a.category})`));

  // Fill buffer
  const currentBuffer = loadBuffer();
  if (currentBuffer.length < 3 && !isTimedOut()) {
    console.log(`\nBuffer has ${currentBuffer.length}, filling...`);
    await fillBuffer(feeds, history);
  }

  const finalBuffer = loadBuffer();
  console.log(`Buffer: ${finalBuffer.length} articles`);
  console.log(`Done in ${(elapsed() / 1000).toFixed(1)}s`);
}

async function fillBuffer(feeds, history) {
  const buffer = loadBuffer();
  const cats = [...CATEGORIES].sort(() => Math.random() - 0.5);
  for (const cat of cats) {
    if (isTimedOut() || buffer.length >= 5) break;
    const categoryFeeds = feeds[cat];
    if (!categoryFeeds) continue;
    const shuffled = [...categoryFeeds].sort(() => Math.random() - 0.5).slice(0, 2);
    for (const feed of shuffled) {
      if (isTimedOut() || buffer.length >= 5) break;
      const items = await fetchFeed(feed);
      const unused = items
        .filter((i) => !history.recent.includes(i.link) && !buffer.some((b) => b.url === i.link))
        .slice(0, 3);
      for (const item of unused) {
        if (isTimedOut() || buffer.length >= 5) break;
        const article = await extractArticle(item.link);
        if (!article) continue;
        if (article.wordCount >= MIN_WORDS * 0.6 && article.wordCount <= MAX_WORDS * 1.5) {
          const entry = {
            title: article.title || item.title,
            source: item.source,
            author: article.author || null,
            url: item.link,
            date: item.date,
            category: cat,
            wordCount: article.wordCount,
            content: article.content,
            fetchedAt: new Date().toISOString(),
          };
          addToBuffer(entry);
          buffer.push(entry);
          console.log(`  Buffered: "${entry.title}" (${entry.wordCount}w, ${cat})`);
        }
      }
    }
  }
}

run();
