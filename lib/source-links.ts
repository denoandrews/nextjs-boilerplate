/**
 * Clickable sources for municipal citations.
 *
 * A citation URL is used only when one of these is known:
 * 1. `documents.external_url` in Supabase for that OpenAI file id
 * 2. a vector-store file attribute named `source_url`, `url`, or `external_url`
 * 3. a filename→URL pattern below
 * 4. an https URL embedded in the filename on an allowlisted host
 *
 * Production files were not modified. Until attributes and `external_url` are
 * filled in, most packet PDFs stay plain text. Agenda and minutes filenames
 * link to the Village Board meetings page. A remedial-action plan is left
 * unlinked on purpose. The assistant also shares the official pages listed
 * for the municipality.
 *
 * Recommended follow-up (do not re-upload or delete the production store):
 * set attributes in place with `vectorStores.files.update`:
 * - `source_url` (https URL of the official file or page)
 * - `document_type` (`ordinance`, `resolution`, `minutes`, `agenda`, `policy`,
 *   `guideline`, `draft`, or `study`)
 * - `record_date` (8-digit YYYYMMDD number, such as 20261013; some files omit it)
 * - `status` (`adopted`, `draft`, `proposed`, or `superseded`)
 * Also set `documents.external_url` for rows that already have `openai_file_id`.
 * Oak Park chat may filter on document_type when the question names minutes,
 * an agenda, or a budget. It does not filter on record_date, because files
 * without that attribute would drop out of search. Other municipalities stay
 * unfiltered until their files have document_type on every record.
 */

import { canonicalHttpsUrl } from "@/lib/web-sources";

export type OfficialPage = {
  title: string;
  url: string;
  useWhen: string;
};

type FilenameLink = {
  pattern: RegExp;
  url: string;
};

const OAK_PARK_MEETINGS_URL = "https://www.oak-park.us/Government/Meetings/Village-Board-Agendas-Minutes-Videos";

const OAK_PARK_PAGES: OfficialPage[] = [
  {
    title: "Board meetings",
    url: OAK_PARK_MEETINGS_URL,
    useWhen: "Next or latest meeting, agendas, minutes, and videos.",
  },
  {
    title: "Village website",
    url: "https://www.oak-park.us/",
    useWhen: "Person records may be incomplete.",
  },
  {
    title: "Village Board",
    url: "https://www.oak-park.us/Government/Leadership/Village-Board",
    useWhen: "Trustees and the Village President.",
  },
  {
    title: "FOIA",
    url: "https://www.oak-park.us/Government/Information-and-Resources/Freedom-of-Information-Act-FOIA",
    useWhen: "How to request public records.",
  },
  {
    title: "Parking permits",
    url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Permits",
    useWhen: "Permits and vehicle licenses, not tickets.",
  },
  {
    title: "Parking enforcement",
    url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Enforcement",
    useWhen: "Tickets. Lakeshore Recycling Systems is not a parking provider.",
  },
  {
    title: "Adjudication",
    url: "https://www.oak-park.us/Government/Departments/Office-of-Adjudication",
    useWhen: "Contesting a citation and how fines are collected.",
  },
  {
    title: "Waste and recycling",
    url: "https://www.oak-park.us/Services-Parking/Waste-Recycling",
    useWhen: "Trash, recycling, and yard waste.",
  },
  {
    title: "Garbage collection",
    url: "https://www.oak-park.us/Services-Parking/Waste-Recycling/Garbage-Collection",
    useWhen: "How to find a pickup day. Do not invent a weekday.",
  },
  {
    title: "Lakeshore Recycling Systems",
    url: "https://www.lrsrecycles.com/municipality/oak-park/",
    useWhen: "Missed pickup. The waste hauler is not a parking provider.",
  },
  {
    title: "Building permits",
    url: "https://www.oak-park.us/Building-Business/Building-Permits",
    useWhen: "Permits and where current fees are published.",
  },
  {
    title: "Zoning",
    url: "https://www.oak-park.us/Building-Business/Development/Zoning",
    useWhen: "Zoning ordinance and map.",
  },
  {
    title: "Zoning ordinance",
    url: "https://www.oak-park.us/files/assets/oakpark/v/3/development-services/planning/__2017-oak-park-zoning-ordinance-revised.04.03.2026x.pdf",
    useWhen: "Prefer this adopted file over a DRAFT.",
  },
  {
    title: "Fence guidelines",
    url: "https://www.oak-park.us/files/assets/oakpark/v/1/development-services/permits/fence-guidelines-2025-08.pdf",
    useWhen: "Fence permits and fence rules.",
  },
  {
    title: "Village Code",
    url: "https://codelibrary.amlegal.com/codes/oakparkil/latest/overview",
    useWhen: "Codified ordinances.",
  },
  {
    title: "Budget book",
    url: "https://www.oak-park.us/files/assets/oakpark/v/2/finance/budgets/fy26-budget-book-final.pdf",
    useWhen: "A property tax levy is not the general fund budget.",
  },
];

const OAK_PARK_FILENAME_LINKS: FilenameLink[] = [
  {
    pattern: /fence-guidelines/i,
    url: "https://www.oak-park.us/files/assets/oakpark/v/1/development-services/permits/fence-guidelines-2025-08.pdf",
  },
  {
    pattern: /fy26-budget-book-final/i,
    url: "https://www.oak-park.us/files/assets/oakpark/v/2/finance/budgets/fy26-budget-book-final.pdf",
  },
  {
    pattern: /zoning-ordinance-revised/i,
    url: "https://www.oak-park.us/files/assets/oakpark/v/3/development-services/planning/__2017-oak-park-zoning-ordinance-revised.04.03.2026x.pdf",
  },
];

const OAK_PARK_HOSTS = ["oak-park.us", "oak-park.legistar.com", "lrsrecycles.com", "codelibrary.amlegal.com", "webapps1.dot.illinois.gov"];

const OAK_PARK_MENTIONS: { source: string; url: string }[] = [
  { source: "garbage collection page", url: "https://www.oak-park.us/Services-Parking/Waste-Recycling/Garbage-Collection" },
  { source: "Lakeshore Recycling Systems(?: Oak Park)? page", url: "https://www.lrsrecycles.com/municipality/oak-park/" },
  { source: "parking enforcement page", url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Enforcement" },
  { source: "parking permits page", url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Permits" },
  { source: "(?:FOIA|Freedom of Information Act) page", url: "https://www.oak-park.us/Government/Information-and-Resources/Freedom-of-Information-Act-FOIA" },
  { source: "fence guidelines", url: "https://www.oak-park.us/files/assets/oakpark/v/1/development-services/permits/fence-guidelines-2025-08.pdf" },
  { source: "(?:FY ?2026 |the )?budget book", url: "https://www.oak-park.us/files/assets/oakpark/v/2/finance/budgets/fy26-budget-book-final.pdf" },
  { source: "Village Code", url: "https://codelibrary.amlegal.com/codes/oakparkil/latest/overview" },
  { source: "meetings page", url: OAK_PARK_MEETINGS_URL },
  { source: "building permits page", url: "https://www.oak-park.us/Building-Business/Building-Permits" },
];

export function officialPages(slug: string): OfficialPage[] {
  return slug === "oak-park-il" ? OAK_PARK_PAGES : [];
}

export function officialMentions(slug: string): { pattern: RegExp; url: string }[] {
  if (slug !== "oak-park-il") return [];
  return OAK_PARK_MENTIONS.map((mention) => ({ pattern: new RegExp(mention.source, "gi"), url: mention.url }));
}

/** Procurement files and unrelated studies are not shown as answer sources. */
export function excludedCitationFilename(filename: string): boolean {
  const spaced = filename.replace(/[_./-]+/g, " ");
  return /remedial\s+action\s+plan/i.test(spaced)
    || /\brfp\b/i.test(spaced)
    || /request\s+for\s+proposal/i.test(spaced);
}

export function citationSourceNote(url: string | null | undefined, slug?: string): "meetings" | null {
  if (slug !== "oak-park-il" || !url) return null;
  return url === OAK_PARK_MEETINGS_URL ? "meetings" : null;
}

export function linkHosts(slug: string): string[] {
  return slug === "oak-park-il" ? [...OAK_PARK_HOSTS] : [];
}

export function safeHttpsUrl(value: string): string | null {
  return canonicalHttpsUrl(value)?.href ?? null;
}

function hostMatches(hostname: string, domain: string) {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export function allowedAnswerUrl(value: string, slug: string): string | null {
  const href = safeHttpsUrl(value);
  if (!href) return null;
  const hostname = new URL(href).hostname;
  return linkHosts(slug).some((domain) => hostMatches(hostname, domain)) ? href : null;
}

const OAK_PARK_FILENAME_FALLBACKS: FilenameLink[] = [
  {
    pattern: /(?:^|[^a-z])(?:agendas?|minutes)(?:[^a-z]|$)/i,
    url: OAK_PARK_MEETINGS_URL,
  },
];

function matchingFilenameUrl(filename: string, links: FilenameLink[]): string | null {
  const link = links.find((entry) => entry.pattern.test(filename));
  return link ? link.url : null;
}

export function filenameSourceUrl(slug: string | undefined, filename: string): string | null {
  if (slug !== "oak-park-il") return null;
  return matchingFilenameUrl(filename, OAK_PARK_FILENAME_LINKS);
}

export function citationUrlForFile(input: {
  slug?: string;
  filename: string;
  attributeUrl?: string | null;
}): string | null {
  if (input.attributeUrl) {
    const fromAttribute = safeHttpsUrl(input.attributeUrl);
    if (fromAttribute) return fromAttribute;
  }

  const fromFilename = filenameSourceUrl(input.slug, input.filename);
  if (fromFilename) return fromFilename;

  if (!input.slug) return null;
  const embedded = input.filename.match(/https:\/\/[^\s<>"']+/i);
  if (embedded) {
    const fromEmbedded = allowedAnswerUrl(embedded[0].replace(/[),.;]+$/g, ""), input.slug);
    if (fromEmbedded) return fromEmbedded;
  }

  if (input.slug !== "oak-park-il") return null;
  return matchingFilenameUrl(input.filename, OAK_PARK_FILENAME_FALLBACKS);
}

export function withStoredSourceUrls<T extends { fileId: string; url?: string }>(
  citations: T[],
  stored: ReadonlyMap<string, string>
): T[] {
  return citations.map((citation) => {
    const safe = safeHttpsUrl(stored.get(citation.fileId) ?? "");
    return safe ? { ...citation, url: safe } : citation;
  });
}
