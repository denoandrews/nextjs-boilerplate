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
 * filled in, most packet PDFs stay plain text and the assistant shares the
 * official pages listed for the municipality instead.
 *
 * Recommended follow-up (do not re-upload or delete the production store):
 * set attributes in place with `vectorStores.files.update`:
 * - `source_url` (https URL of the official file or page)
 * - `document_type` (`ordinance`, `resolution`, `minutes`, `agenda`, `policy`,
 *   `guideline`, `draft`, or `study`)
 * - `record_date` (`YYYY-MM-DD` adoption, revision, or meeting date)
 * - `status` (`adopted`, `draft`, `proposed`, or `superseded`)
 * Also set `documents.external_url` for rows that already have `openai_file_id`.
 * Do not add a file-search metadata filter until those attributes exist, or
 * every current file would drop out of search.
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

const OAK_PARK_PAGES: OfficialPage[] = [
  {
    title: "Village Board agendas, minutes, and videos",
    url: "https://www.oak-park.us/Government/Meetings/Village-Board-Agendas-Minutes-Videos",
    useWhen:
      "Use for the next or latest Village Board meeting, agendas, minutes, and videos. If the records do not contain a future meeting, say the latest date you found is in the past and give this page instead of guessing a date.",
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
    useWhen: "Use for parking permits, where to get them, and parking services.",
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
      "Share this with the Village garbage page when someone needs their own pickup day or needs to report a missed pickup. Describe it as the hauler the Village lists, not as a Village ordinance.",
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
      "Prefer this over a file labeled DRAFT. A filename that starts with 2017 can still be this revised ordinance. Check the revision date before calling it outdated.",
  },
  {
    title: "Fence guidelines (August 2025)",
    url: "https://www.oak-park.us/files/assets/oakpark/v/1/development-services/permits/fence-guidelines-2025-08.pdf",
    useWhen:
      "Prefer this for whether a fence needs a permit and for fence height and location rules when it is retrieved or when the question is about fence permits.",
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
      "Use for budget figures. If asked for the general fund, give the general fund figure when the source separates it from the all-funds total.",
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

export function officialPages(slug: string): OfficialPage[] {
  return slug === "oak-park-il" ? OAK_PARK_PAGES : [];
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

export function filenameSourceUrl(slug: string | undefined, filename: string): string | null {
  if (slug !== "oak-park-il") return null;
  const link = OAK_PARK_FILENAME_LINKS.find((entry) => entry.pattern.test(filename));
  return link ? link.url : null;
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
  if (!embedded) return null;
  return allowedAnswerUrl(embedded[0].replace(/[),.;]+$/g, ""), input.slug);
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
