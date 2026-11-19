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

/** Longest configured domain wins, so www.oak-park.us stays official rather than a shorter suffix. */
export function matchWebUrl(value: string, sources: WebSource[] = Object.values(MUNICIPAL_WEB_SOURCES).flat()): MatchedWebUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const matches = sources.filter((source) => hostMatches(parsed.hostname, source.domain));
  if (matches.length === 0) return null;
  matches.sort((left, right) => right.domain.length - left.domain.length);
  const best = matches[0];
  return { url: parsed.href, kind: best.kind, label: best.label, domain: best.domain };
}

export function webCitationKind(value: string | null | undefined): WebSourceKind | null {
  if (!value) return null;
  return matchWebUrl(value)?.kind ?? null;
}
