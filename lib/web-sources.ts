/**
 * Per-municipality web search config.
 *
 * `officialSites` are the municipality's own pages. `newspapers` are secondary
 * reporting. OpenAI treats a listed domain as including its subdomains, so
 * `oak-park.us` covers `www.oak-park.us`. Legistar is a different registrable
 * domain, so it is listed on its own. `www.oak-park.us` is also listed so a
 * strict host match still links that host.
 */

export type WebSourceKind = "official" | "newspaper";

export type WebSource = {
  domain: string;
  kind: WebSourceKind;
  label: string;
};

/** IDOT lettings are searched only for a construction-award question, not on every turn. */
export const IDOT_LETTING_SOURCE: WebSource = {
  domain: "webapps1.dot.illinois.gov",
  kind: "official",
  label: "IDOT",
};

const MUNICIPAL_WEB_SOURCES: Record<string, WebSource[]> = {
  "oak-park-il": [
    { domain: "oakpark.com", kind: "newspaper", label: "Wednesday Journal" },
    { domain: "www.oakpark.com", kind: "newspaper", label: "Wednesday Journal" },
    { domain: "chicagotribune.com", kind: "newspaper", label: "Chicago Tribune" },
    { domain: "www.chicagotribune.com", kind: "newspaper", label: "Chicago Tribune" },
    { domain: "oak-park.us", kind: "official", label: "Village of Oak Park" },
    { domain: "www.oak-park.us", kind: "official", label: "Village of Oak Park" },
    { domain: "oak-park.legistar.com", kind: "official", label: "Oak Park Legistar" },
  ],
};

export function webSources(slug: string): WebSource[] {
  return (MUNICIPAL_WEB_SOURCES[slug] ?? []).map((source) => ({ ...source }));
}

export function sourcesByKind(slug: string, kind: WebSourceKind): WebSource[] {
  return webSources(slug).filter((source) => source.kind === kind);
}

export function webSearchDomains(slug: string): string[] {
  return webSources(slug).map((source) => source.domain);
}

export function newspaperDomainsFor(slug: string): string[] {
  return sourcesByKind(slug, "newspaper").map((source) => source.domain);
}

export function officialWebDomains(slug: string): string[] {
  return sourcesByKind(slug, "official").map((source) => source.domain);
}

/**
 * Unset keeps the pass on for any municipality that has sources configured.
 * `0`, `false`, `off`, or `disabled` turns the pass off everywhere.
 */
export function webPassEnabled(slug: string, raw = process.env.MUNIGPT_WEB_SEARCH): boolean {
  if (webSources(slug).length === 0) return false;
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off" || value === "disabled") return false;
  return true;
}

function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const root = domain.toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

export type MatchedWebUrl = {
  url: string;
  kind: WebSourceKind;
  label: string;
  domain: string;
};

/** Drop a trailing backtick, encoded `%60`, or sentence punctuation the model glued onto a URL. */
export function sanitizeUrlText(value: string): string {
  let text = value.trim().replace(/^[<\[('"]+/, "");
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/(?:%60)+$/i, "").replace(/[`"'.,;:!?)\]]+$/g, "");
  }
  return text;
}

function trackingParamName(part: string): string {
  const name = part.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/** Drop `utm_*` query params, including `utm_source=openai`, and keep every other parameter in order. */
function stripTrackingParams(url: URL): void {
  if (!url.search || url.search.length <= 1) return;
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((part) => part.length > 0 && !/^utm_/i.test(trackingParamName(part)));
  url.search = kept.length > 0 ? `?${kept.join("&")}` : "";
}

/** An https URL with tracking parameters removed. Rejects credentials and other schemes. */
export function canonicalHttpsUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(sanitizeUrlText(value));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  stripTrackingParams(parsed);
  return parsed;
}

/** Longest configured domain wins, so www.oak-park.us stays official rather than a shorter suffix. */
export function matchWebUrl(value: string, sources: WebSource[] = Object.values(MUNICIPAL_WEB_SOURCES).flat()): MatchedWebUrl | null {
  const parsed = canonicalHttpsUrl(value);
  if (!parsed) return null;
  const matches = sources.filter((source) => hostMatches(parsed.hostname, source.domain));
  if (matches.length === 0) return null;
  matches.sort((left, right) => right.domain.length - left.domain.length);
  const best = matches[0];
  return { url: parsed.href, kind: best.kind, label: best.label, domain: best.domain };
}

export function webCitationKind(value: string | null | undefined): WebSourceKind | null {
  if (!value) return null;
  return matchWebUrl(value)?.kind ?? matchWebUrl(value, [IDOT_LETTING_SOURCE])?.kind ?? null;
}
