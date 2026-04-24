import type { HtmlPaginationConfig, PaginationStrategyName } from "./types.js";

type PaginationStrategy = (baseUrl: string, maxPages: number) => string[];

function walkerplusEventListPages(baseUrl: string, maxPages: number): string[] {
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const urls = [normalizedBaseUrl];

  for (let page = 2; page <= maxPages; page += 1) {
    urls.push(new URL(`${page}.html`, normalizedBaseUrl).toString());
  }

  return urls;
}

function enjoytokyoEventListPages(baseUrl: string, maxPages: number): string[] {
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const urls = [normalizedBaseUrl];

  for (let page = 2; page <= maxPages; page += 1) {
    urls.push(new URL(`${page}/`, normalizedBaseUrl).toString());
  }

  return urls;
}

function artscapeExhibitionListPages(baseUrl: string, maxPages: number): string[] {
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const urls = [normalizedBaseUrl];

  for (let page = 2; page <= maxPages; page += 1) {
    const url = new URL(normalizedBaseUrl);
    url.searchParams.set("paged", String(page));
    urls.push(url.toString());
  }

  return urls;
}

const STRATEGIES: Record<PaginationStrategyName, PaginationStrategy> = {
  walkerplus_event_list_pages: walkerplusEventListPages,
  enjoytokyo_event_list_pages: enjoytokyoEventListPages,
  artscape_exhibition_list_pages: artscapeExhibitionListPages
};

export function buildPaginationUrls(
  baseUrl: string,
  pagination: HtmlPaginationConfig | undefined
): string[] {
  if (!pagination) {
    return [new URL(baseUrl).toString()];
  }

  const maxPages = pagination.maxPages ?? 1;
  const strategy = STRATEGIES[pagination.strategy];
  return strategy(baseUrl, maxPages);
}
