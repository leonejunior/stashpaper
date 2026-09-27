import { requestUrl } from "obsidian";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export interface ParsedArticle {
  title: string;
  byline?: string;
  markdown: string;
  sourceUrl: string;
}

export interface FetchArticleOptions {
  keepImages?: boolean;
}

/**
 * Strips markdown and HTML image syntax from a markdown string.
 */
export function stripMarkdownImages(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // ![alt](url)
    .replace(/<img[^>]*\/?>/gi, "")          // <img ...>
    .replace(/\n{3,}/g, "\n\n");            // collapse excess empty lines
}

/**
 * Validates and normalizes user-provided URLs.
 */
function normalizeUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("URL cannot be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL format: "${trimmed}". Please provide a full URL including http:// or https://`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Only http:// and https:// URLs are supported.`);
  }

  return parsed;
}

/**
 * Converts Electron / network / HTTP errors into clear human-friendly error messages.
 */
function formatNetworkError(err: unknown, targetUrl: URL): Error {
  const rawMsg = err instanceof Error ? err.message : String(err);

  if (rawMsg.includes("net::ERR_NAME_NOT_RESOLVED")) {
    return new Error(
      `Could not find server "${targetUrl.hostname}". Please check the URL for typos or verify your internet connection.`
    );
  }
  if (rawMsg.includes("net::ERR_INTERNET_DISCONNECTED")) {
    return new Error("No internet connection detected. Please check your network.");
  }
  if (rawMsg.includes("net::ERR_CONNECTION_REFUSED")) {
    return new Error(`Connection refused by ${targetUrl.hostname}. The website server may be offline.`);
  }
  if (
    rawMsg.includes("net::ERR_TIMED_OUT") ||
    rawMsg.includes("net::ERR_CONNECTION_TIMED_OUT") ||
    rawMsg.toLowerCase().includes("timeout")
  ) {
    return new Error(`Connection timed out while reaching ${targetUrl.hostname}.`);
  }
  if (rawMsg.includes("net::ERR_CERT_") || rawMsg.includes("net::ERR_SSL_")) {
    return new Error(`SSL certificate error when connecting to ${targetUrl.hostname}.`);
  }
  if (rawMsg.includes("status 404") || rawMsg.includes("404")) {
    return new Error(`Article not found (404) at ${targetUrl.toString()}.`);
  }
  if (rawMsg.includes("status 403") || rawMsg.includes("403")) {
    return new Error(`Access forbidden (403) for ${targetUrl.hostname}. The site may require a subscription or block bots.`);
  }
  if (rawMsg.includes("status 500") || rawMsg.includes("500")) {
    return new Error(`The website server for ${targetUrl.hostname} encountered an internal server error (500).`);
  }

  // Fallback: strip noisy Electron prefixes
  const cleanMsg = rawMsg
    .replace(/^Error:\s*/i, "")
    .replace(/net::[A-Z0-9_]+/g, "")
    .trim();

  return new Error(cleanMsg || `Failed to fetch from ${targetUrl.hostname}.`);
}

export async function fetchAndParseArticle(
  url: string,
  options?: FetchArticleOptions
): Promise<ParsedArticle> {
  const parsedUrl = normalizeUrl(url);

  let html: string;
  try {
    const res = await requestUrl({ url: parsedUrl.toString() });
    if (res.status && (res.status < 200 || res.status >= 300)) {
      if (res.status === 404) {
        throw new Error(`Article not found (HTTP 404) at ${parsedUrl.toString()}.`);
      }
      if (res.status === 403) {
        throw new Error(`Access forbidden (HTTP 403) for ${parsedUrl.hostname}.`);
      }
      throw new Error(`Server returned HTTP error status ${res.status}.`);
    }
    html = res.text;
  } catch (err) {
    throw formatNetworkError(err, parsedUrl);
  }

  // Parse into DOM Document in isolated context
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Ensure <base href="..."> is present so Readability resolves relative links/images
  let base = doc.querySelector("base");
  if (!base) {
    base = doc.createElement("base");
    if (doc.head) {
      doc.head.appendChild(base);
    } else {
      doc.documentElement.prepend(base);
    }
  }
  base.setAttribute("href", parsedUrl.toString());

  // Wrap Readability parse step explicitly
  let article: ReturnType<Readability["parse"]> = null;
  try {
    const reader = new Readability(doc);
    article = reader.parse();
  } catch (parseErr: unknown) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Readability could not parse this page: ${detail}`);
  }

  if (!article || !article.content) {
    throw new Error(
      "Readability could not parse this page. The page may require JavaScript to render, be behind a paywall, or lack article structure."
    );
  }

  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });

  // If keepImages is false, strip image tags during markdown conversion
  if (options?.keepImages === false) {
    turndownService.addRule("stripImages", {
      filter: "img",
      replacement: () => "",
    });
  }

  let markdown = turndownService.turndown(article.content || "");

  if (options?.keepImages === false) {
    markdown = stripMarkdownImages(markdown);
  }

  return {
    title: article.title || "Untitled article",
    byline: article.byline || undefined,
    markdown,
    sourceUrl: parsedUrl.toString(),
  };
}
