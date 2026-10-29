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
    title: "Village Board agendas, minutes, and videos",
    url: OAK_PARK_MEETINGS_URL,
    useWhen:
      "Use for the next or latest Village Board meeting, agendas, minutes, and videos. If the records do not include a future meeting, say that in the first sentence, give the latest meeting as already passed, and give this page for the upcoming schedule. Do not present a past meeting, including October 13, 2026 on a later day, as the next meeting.",
  },
  {
    title: "Village Board and trustees",
    url: "https://www.oak-park.us/Government/Leadership/Village-Board",
    useWhen: "Use for who the trustees and Village President are and how to contact the Board.",
  },
  {
    title: "Freedom of Information Act",
    url: "https://www.oak-park.us/Government/Information-and-Resources/Freedom-of-Information-Act-FOIA",
    useWhen:
      "Use for how to request public records. Do not answer a FOIA question from an unrelated study or remedial-action plan.",
  },
  {
    title: "Parking permits",
    url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Permits",
    useWhen:
      "Use only for parking permits, permit maps, and vehicle licenses. Do not use this page for a parking ticket, a fine, or how to pay or contest a citation.",
  },
  {
    title: "Parking enforcement",
    url: "https://www.oak-park.us/Services-Parking/Parking-Mobility-Services/Parking-Enforcement",
    useWhen:
      "Use for a parking ticket, how to pay or contest one, and the parking-enforcement contact. Parking fines are collected by the Office of Adjudication, not by the permits desk. Lakeshore Recycling Systems is the waste hauler and is not a parking provider. A parking-services request for proposal or other vendor proposal is not the current payment policy and may be outdated.",
  },
  {
    title: "Office of Adjudication",
    url: "https://www.oak-park.us/Government/Departments/Office-of-Adjudication",
    useWhen:
      "Use for contesting a parking ticket or other municipal citation and for how fines are collected. Do not send a ticket question to the parking permits page.",
  },
  {
    title: "Waste and recycling",
    url: "https://www.oak-park.us/Services-Parking/Waste-Recycling",
    useWhen: "Use for an overview of trash, recycling, and yard-waste service.",
  },
  {
    title: "Garbage and yard waste collection",
    url: "https://www.oak-park.us/Services-Parking/Waste-Recycling/Garbage-Collection",
    useWhen:
      "Use when someone asks how to find their pickup day. Say that the day depends on the address, that buildings of five or fewer units are collected once a week, and that trash, recycling, and yard waste share that weekday. Give this page. Do not invent a weekday.",
  },
  {
    title: "Collection information from the Village hauler, Lakeshore Recycling Systems",
    url: "https://www.lrsrecycles.com/municipality/oak-park/",
    useWhen:
      "Share this with the Village garbage page when someone needs their own pickup day or needs to report a missed pickup. Lakeshore Recycling Systems is the waste and recycling hauler only. Never describe it as the parking provider or send a parking-ticket question here.",
  },
  {
    title: "Building permits",
    url: "https://www.oak-park.us/Building-Business/Building-Permits",
    useWhen:
      "Use for sheds, garages, decks, fences, and other construction permits, and for where current permit fees are published. A vendor proposal, bid, or request for proposal is not the current fee schedule and may be outdated. Prefer this page over an older proposal.",
  },
  {
    title: "Zoning",
    url: "https://www.oak-park.us/Building-Business/Development/Zoning",
    useWhen: "Use for where the current zoning ordinance and zoning map are published.",
  },
  {
    title: "Current zoning ordinance (adopted September 18, 2017; revised April 3, 2026)",
    url: "https://www.oak-park.us/files/assets/oakpark/v/3/development-services/planning/__2017-oak-park-zoning-ordinance-revised.04.03.2026x.pdf",
    useWhen:
      "Prefer this over a file labeled DRAFT. This is the only 2017 filename that can still be current, and only because it was revised April 3, 2026. Do not apply that exception to agendas or minutes.",
  },
  {
    title: "Fence guidelines (August 2025)",
    url: "https://www.oak-park.us/files/assets/oakpark/v/1/development-services/permits/fence-guidelines-2025-08.pdf",
    useWhen:
      "These August 2025 guidelines are the current fence rules. A permit is required, except for repair or replacement of existing fencing in a single or cumulative area not exceeding 100 square feet. Say that directly when asked whether a permit is required. Do not call a 2022 ordinance the current rule when these guidelines are available.",
  },
  {
    title: "Village Code",
    url: "https://codelibrary.amlegal.com/codes/oakparkil/latest/overview",
    useWhen: "Use for codified ordinances, including noise and other rules that a draft or unrelated plan does not establish.",
  },
  {
    title: "FY2026 budget book",
    url: "https://www.oak-park.us/files/assets/oakpark/v/2/finance/budgets/fy26-budget-book-final.pdf",
    useWhen:
      "Use for budget figures. If asked for the general fund, state the FY2026 general fund total of $114,695,709. A property tax levy is not the general fund budget. The $19,125,000 levy is separate; mention it in one later sentence only, and do not open with it unless the user or an earlier turn mentions that levy.",
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

const OAK_PARK_HOSTS = ["oak-park.us", "lrsrecycles.com", "codelibrary.amlegal.com"];

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
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
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
