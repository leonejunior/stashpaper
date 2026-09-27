import { App, TFile } from "obsidian";
import { type ParsedArticle, stripMarkdownImages } from "./fetcher";

// Characters forbidden in vault file/folder names on all three major OSes
// (Windows is the most restrictive; we honour that everywhere for portability)
const UNSAFE_FILENAME_RE = /[\\/:*?"<>|#^[\]]/g;

/**
 * Turn an arbitrary article title into a safe Obsidian file-name stem.
 * – Strips path-unsafe characters
 * – Collapses consecutive whitespace / underscores
 * – Trims leading/trailing whitespace and dots
 * – Falls back to "Untitled article" if nothing survives sanitisation
 */
export function sanitizeFilename(title: string): string {
  let safe = title
    .replace(UNSAFE_FILENAME_RE, " ") // replace forbidden chars with space
    .replace(/\s+/g, " ")             // collapse runs of whitespace
    .trim()
    .replace(/^\.+|\.+$/g, "");       // trim leading/trailing dots

  return safe || "Untitled article";
}

/**
 * Build a YAML frontmatter block as a plain string.
 * Values are single-quoted so that colons, special chars, etc. are safe.
 */
function buildFrontmatter(
  title: string,
  sourceUrl: string,
  byline: string | undefined,
  dateSaved: string,
  tags: string[],
  readingTimeMinutes?: number
): string {
  const lines: string[] = ["---"];

  lines.push(`title: '${title.replace(/'/g, "''")}'`);
  lines.push(`source_url: '${sourceUrl}'`);

  if (byline) {
    lines.push(`author: '${byline.replace(/'/g, "''")}'`);
  }

  lines.push(`date_saved: ${dateSaved}`);
  lines.push(`status: unread`);
  lines.push(`progress: 0`);

  if (readingTimeMinutes && readingTimeMinutes > 0) {
    lines.push(`reading_time_minutes: ${readingTimeMinutes}`);
  }

  if (tags.length > 0) {
    lines.push("tags:");
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  } else {
    lines.push("tags: []");
  }

  lines.push("---");
  return lines.join("\n");
}

/** Returns today's date as a YYYY-MM-DD string (local time). */
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Ensure every segment of `folderPath` exists in the vault, creating any
 * missing intermediate folders.  Obsidian's `createFolder` throws when the
 * folder already exists, so we check first.
 */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
  // Walk from the root down so nested folders are created in order
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getFolderByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

/**
 * Write the article as a new Markdown note inside the vault.
 *
 * @returns the newly created TFile
 * @throws  if the vault write fails for any reason
 */
export async function writeArticleNote(
  app: App,
  article: ParsedArticle,
  folder: string,
  tags: string[],
  options?: { keepImages?: boolean }
): Promise<TFile> {
  const dateSaved = todayISO();
  const stem = sanitizeFilename(article.title);

  // ── 1. Build file path, deduplicating if a note with that name already exists
  const basePath = `${folder}/${stem}`;
  let filePath = `${basePath}.md`;
  let counter = 2;
  while (app.vault.getAbstractFileByPath(filePath)) {
    filePath = `${basePath} (${counter}).md`;
    counter++;
  }

  // If keepImages is false, ensure image tags are stripped from markdown
  const bodyMarkdown =
    options?.keepImages === false
      ? stripMarkdownImages(article.markdown)
      : article.markdown;

  // Estimate reading time: ~200 words/min average reading speed
  const wordCount = bodyMarkdown.trim().split(/\s+/).length;
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));

  // ── 2. Build content
  const frontmatter = buildFrontmatter(
    article.title,
    article.sourceUrl,
    article.byline,
    dateSaved,
    tags,
    readingTimeMinutes
  );
  const content = `${frontmatter}\n\n${bodyMarkdown}\n`;

  // ── 3. Ensure the destination folder exists
  await ensureFolder(app, folder);

  // ── 4. Write the file
  const file = await app.vault.create(filePath, content);
  return file;
}
