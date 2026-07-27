import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARTICLE_PATH = join(ROOT, "data", "today.json");
const ARCHIVE_DATA_PATH = join(ROOT, "data", "archive.json");
const PAGE_TEMPLATE_PATH = join(ROOT, "templates", "page.html");
const ARCHIVE_TEMPLATE_PATH = join(ROOT, "templates", "archive.html");
const PUBLIC_DIR = join(ROOT, "public");

if (!existsSync(ARTICLE_PATH)) {
  console.error("No article found. Run fetch-article.js first.");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(ARTICLE_PATH, "utf-8"));
const articles = Array.isArray(raw) ? raw : [raw];
const pageTemplate = readFileSync(PAGE_TEMPLATE_PATH, "utf-8");
const archiveTemplate = readFileSync(ARCHIVE_TEMPLATE_PATH, "utf-8");

const categoryLabels = {
  tech: "Technology",
  law: "Law",
  gaming: "Gaming",
  fun: "Interesting Reads",
};

const date = new Date(articles[0].fetchedAt);
const dateStr = date.toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const dateSlug = date.toISOString().slice(0, 10);

let feedWarning = "";
if (articles[0].failedCategories && articles[0].failedCategories.length > 0) {
  const names = articles[0].failedCategories.map((c) => categoryLabels[c] || c).join(", ");
  feedWarning = `<div class="feed-warning">Some sources need attention: ${escapeHtml(names)} feeds failed to return articles.</div>`;
}

// Build article sections for embedding
const articleDataForPage = articles.map((a) => ({
  title: a.title,
  source: a.source,
  author: a.author || "",
  url: a.url,
  category: a.category,
  categoryLabel: categoryLabels[a.category] || a.category,
  wordCount: a.wordCount,
  readingTime: Math.ceil(a.wordCount / 200),
  content: a.content,
}));

const html = pageTemplate
  .replaceAll("{{DATE}}", dateStr)
  .replaceAll("{{FEED_WARNING}}", feedWarning)
  .replaceAll("{{ARTICLES_JSON}}", JSON.stringify(articleDataForPage))
  .replaceAll("{{TOTAL_ARTICLES}}", articles.length.toString());

mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(join(PUBLIC_DIR, "index.html"), html);
console.log(`Built: public/index.html — ${articles.length} articles`);

// Write archive pages for each article
const archiveDir = join(PUBLIC_DIR, "archive");
mkdirSync(archiveDir, { recursive: true });

const archive = loadArchive().map((e) => {
  if (!e.slug) e.slug = e.date;
  return e;
});

for (let i = 0; i < articles.length; i++) {
  const a = articles[i];
  const slug = i === 0 ? dateSlug : `${dateSlug}-${i + 1}`;
  const singleHtml = buildSingleArticlePage(a);
  const archivePage = singleHtml.replace('href="archive.html"', 'href="../archive.html"');
  writeFileSync(join(archiveDir, `${slug}.html`), archivePage);

  const entry = {
    date: dateSlug,
    slug,
    title: a.title,
    source: a.source,
    category: a.category,
    wordCount: a.wordCount,
  };
  const existingIdx = archive.findIndex((e) => e.slug === slug);
  if (existingIdx >= 0) {
    archive[existingIdx] = entry;
  } else {
    archive.push(entry);
  }
}

archive.sort((a, b) => b.slug.localeCompare(a.slug));
saveArchive(archive);

const archiveHtml = buildArchiveHtml(archive);
writeFileSync(join(PUBLIC_DIR, "archive.html"), archiveHtml);
console.log(`Built: public/archive.html (${archive.length} entries)`);

function buildSingleArticlePage(article) {
  const singleTemplate = readFileSync(join(ROOT, "templates", "single.html"), "utf-8");
  return singleTemplate
    .replaceAll("{{TITLE}}", escapeHtml(article.title))
    .replaceAll("{{SOURCE}}", escapeHtml(article.source))
    .replaceAll("{{AUTHOR_BLOCK}}", article.author ? `<span class="sep">·</span><span>${escapeHtml(article.author)}</span>` : "")
    .replaceAll("{{DATE}}", dateStr)
    .replaceAll("{{CATEGORY}}", categoryLabels[article.category] || article.category)
    .replaceAll("{{WORD_COUNT}}", article.wordCount.toString())
    .replaceAll("{{READING_TIME}}", Math.ceil(article.wordCount / 200).toString())
    .replaceAll("{{CONTENT}}", article.content)
    .replaceAll("{{ORIGINAL_URL}}", escapeHtml(article.url));
}

function loadArchive() {
  if (!existsSync(ARCHIVE_DATA_PATH)) return [];
  try {
    return JSON.parse(readFileSync(ARCHIVE_DATA_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveArchive(archive) {
  writeFileSync(ARCHIVE_DATA_PATH, JSON.stringify(archive, null, 2));
}

function buildArchiveHtml(archive) {
  const grouped = {};
  for (const entry of archive) {
    const d = new Date(entry.date + "T00:00:00");
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
    if (!grouped[monthKey]) grouped[monthKey] = { label: monthLabel, entries: [] };
    grouped[monthKey].entries.push(entry);
  }

  const months = Object.keys(grouped).sort().reverse();
  let entriesHtml = "";

  for (const monthKey of months) {
    const group = grouped[monthKey];
    entriesHtml += `<div class="month-group">\n`;
    entriesHtml += `  <div class="month-label">${group.label}</div>\n`;
    for (const entry of group.entries) {
      const day = new Date(entry.date + "T00:00:00").getDate();
      const cat = categoryLabels[entry.category] || entry.category;
      entriesHtml += `  <a href="archive/${entry.slug}.html" class="entry">\n`;
      entriesHtml += `    <span class="entry-date">${String(day).padStart(2, " ")}</span>\n`;
      entriesHtml += `    <span class="entry-title">${escapeHtml(entry.title)}</span>\n`;
      entriesHtml += `    <span class="entry-category">${escapeHtml(cat)}</span>\n`;
      entriesHtml += `    <span class="entry-source">${escapeHtml(entry.source)}</span>\n`;
      entriesHtml += `  </a>\n`;
    }
    entriesHtml += `</div>\n`;
  }

  if (entriesHtml === "") {
    entriesHtml = `<p style="color: var(--text-faint);">No articles yet.</p>`;
  }

  return archiveTemplate.replace("{{ARCHIVE_ENTRIES}}", entriesHtml);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
