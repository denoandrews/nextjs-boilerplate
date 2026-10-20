import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXTRACT_MODEL,
  VOTE_EXTRACTION_SCHEMA,
  applyDedupe,
  buildBatchRequestLine,
  classifyMinutesCandidate,
  dedupeMeetings,
  finalizeMeeting,
  matchMemberName,
  membersFromSeed,
  normalizePersonName,
  oakParkSeedMembers,
  selectSpread,
  validateTally,
  type ParsedExtraction,
  type StoredMeeting,
  type VoteChoice,
} from "./vote-extraction";

function votes(names: [string, VoteChoice][]) {
  return names.map(([raw_name, choice]) => ({ raw_name, choice }));
}

function tallyMotion(overrides: Partial<Parameters<typeof validateTally>[0]> = {}) {
  return {
    tally_aye: null,
    tally_nay: null,
    tally_abstain: null,
    tally_absent: null,
    tally_recused: null,
    tally_text: null,
    note: null,
    votes: [] as { choice: VoteChoice }[],
    ...overrides,
  };
}

const emptyModel = (motions: ParsedExtraction["motions"]): ParsedExtraction => ({
  meeting_date: "2024-03-18",
  body: "Village Board",
  minutes_status: "approved",
  motions,
});

function motion(overrides: Partial<ParsedExtraction["motions"][number]> = {}): ParsedExtraction["motions"][number] {
  return {
    item_number: "1",
    title: "Consent agenda",
    motion_text: null,
    mover_raw: null,
    seconder_raw: null,
    result: "passed",
    tally_aye: null,
    tally_nay: null,
    tally_abstain: null,
    tally_absent: null,
    tally_recused: null,
    tally_text: null,
    source_page: null,
    note: null,
    votes: [],
    ...overrides,
  };
}

describe("tally validation", () => {
  it("accepts a 6-1 vote with one nay", () => {
    const result = validateTally(tallyMotion({
      tally_text: "6-1",
      tally_aye: 6,
      tally_nay: 1,
      votes: votes([
        ["Andrews", "aye"],
        ["Buchanan", "aye"],
        ["Enyia", "aye"],
        ["Parakkat", "aye"],
        ["Scaman", "aye"],
        ["Straw", "aye"],
        ["Walker-Peddakotla", "nay"],
      ]),
    }));
    expect(result.status).toBe("ok");
  });

  it("rejects a printed 6-1 when two people are listed as nay", () => {
    const result = validateTally(tallyMotion({
      tally_text: "6-1",
      tally_aye: 6,
      tally_nay: 1,
      votes: votes([
        ["Andrews", "nay"],
        ["Buchanan", "aye"],
        ["Enyia", "aye"],
        ["Parakkat", "aye"],
        ["Scaman", "aye"],
        ["Straw", "aye"],
        ["Walker-Peddakotla", "nay"],
      ]),
    }));
    expect(result.status).toBe("tally_mismatch");
    expect(result.note).toMatch(/6-1/);
    expect(result.note).toMatch(/2 nay/);
  });

  it("accepts a 7-0 unanimous vote and rejects a nay hidden inside it", () => {
    expect(validateTally(tallyMotion({
      tally_text: "7-0",
      votes: votes([
        ["Andrews", "aye"],
        ["Buchanan", "aye"],
        ["Enyia", "aye"],
        ["Parakkat", "aye"],
        ["Scaman", "aye"],
        ["Straw", "aye"],
        ["Walker-Peddakotla", "aye"],
      ]),
    })).status).toBe("ok");

    const hiddenNay = validateTally(tallyMotion({
      tally_text: "7-0",
      votes: votes([
        ["Andrews", "nay"],
        ["Buchanan", "aye"],
        ["Enyia", "aye"],
        ["Parakkat", "aye"],
        ["Scaman", "aye"],
        ["Straw", "aye"],
        ["Walker-Peddakotla", "aye"],
      ]),
    }));
    expect(hiddenNay.status).toBe("tally_mismatch");
  });

  it("does not store a unanimous vote as a two-person split", () => {
    const result = validateTally(tallyMotion({
      tally_text: "7-0",
      note: "only two members voted no",
      votes: votes([
        ["Andrews", "aye"],
        ["Buchanan", "aye"],
        ["Enyia", "aye"],
        ["Parakkat", "aye"],
        ["Scaman", "aye"],
        ["Straw", "aye"],
        ["Walker-Peddakotla", "aye"],
      ]),
    }));
    expect(result.status).toBe("tally_mismatch");
    expect(result.note).toMatch(/two-person split/);
  });

  it("treats a voice vote with no names and no printed split as ok", () => {
    const result = validateTally(tallyMotion({ note: "Voice vote." }));
    expect(result.status).toBe("ok");
    expect(result.note).toMatch(/voice vote/i);
  });

  it("rejects a printed split that has no member rows", () => {
    expect(validateTally(tallyMotion({ tally_text: "4-2" })).status).toBe("tally_mismatch");
  });
});

describe("name normalization", () => {
  const seed = oakParkSeedMembers();

  it("strips titles and treats hyphenation as the same name", () => {
    expect(normalizePersonName("Trustee Andrews")).toBe("andrews");
    expect(normalizePersonName("President Scaman")).toBe("scaman");
    expect(normalizePersonName("Village President Scaman")).toBe("scaman");
    expect(normalizePersonName("Walker-Peddakotla")).toBe(normalizePersonName("Walker Peddakotla"));
    expect(matchMemberName("Trustee Andrews", seed).status).toBe("matched");
    expect(matchMemberName("Trustee Walker-Peddakotla", seed).member_id).toBe(
      matchMemberName("Walker Peddakotla", seed).member_id,
    );
  });

  it("does not merge a different person who only shares a surname", () => {
    const members = membersFromSeed([
      { body: "Village Board", canonical_name: "Deno Andrews", aliases: ["Trustee Deno Andrews"] },
    ]);
    const match = matchMemberName("Andrea Andrews", members);
    expect(match.status).toBe("unknown");
    expect(match.member_id).toBeNull();
  });

  it("leaves an unknown name unmatched and flags two members that share an alias", () => {
    expect(matchMemberName("Trustee Buchanan", seed)).toEqual({ member_id: null, status: "unknown" });
    const ambiguous = membersFromSeed([
      { body: "Village Board", canonical_name: "Deno Andrews", aliases: ["Andrews"] },
      { body: "Village Board", canonical_name: "Andrea Andrews", aliases: ["Andrews"] },
    ]);
    expect(matchMemberName("Trustee Andrews", ambiguous)).toEqual({ member_id: null, status: "ambiguous" });
  });

  it("marks unknown names needs_review and keeps a tally mismatch ahead of that", () => {
    const known = finalizeMeeting({
      fileId: "file-known",
      filename: "2024-03-18_VillageBoard_Minutes.pdf",
      recordDate: 20240318,
      untagged: false,
      truncated: false,
      members: seed,
      model: emptyModel([motion({
        tally_text: "1-0",
        votes: votes([["Trustee Andrews", "aye"]]),
      })]),
    });
    expect(known.motions[0].votes[0].member_id).toBe(seed[0].id);
    expect(known.motions[0].validation_status).toBe("ok");

    const unknown = finalizeMeeting({
      fileId: "file-unknown",
      filename: "2024-03-18_VillageBoard_Minutes.pdf",
      recordDate: 20240318,
      untagged: false,
      truncated: false,
      members: seed,
      model: emptyModel([motion({
        tally_text: "1-0",
        votes: votes([["Trustee Buchanan", "aye"]]),
      })]),
    });
    expect(unknown.motions[0].votes[0].member_id).toBeNull();
    expect(unknown.motions[0].validation_status).toBe("needs_review");
    expect(unknown.motions[0].validation_note).toMatch(/Unknown name: Trustee Buchanan/);

    const mismatch = finalizeMeeting({
      fileId: "file-bad",
      filename: "2024-03-18_VillageBoard_Minutes.pdf",
      recordDate: 20240318,
      untagged: false,
      truncated: false,
      members: seed,
      model: emptyModel([motion({
        tally_text: "6-1",
        votes: votes([
          ["Trustee Andrews", "nay"],
          ["Trustee Buchanan", "nay"],
        ]),
      })]),
    });
    expect(mismatch.motions[0].validation_status).toBe("tally_mismatch");
  });
});

describe("meeting date check", () => {
  it("keeps record_date and flags a disagreement for review", () => {
    const disagreed = finalizeMeeting({
      fileId: "file-date",
      filename: "2024-03-18_VillageBoard_Minutes.pdf",
      recordDate: 20240318,
      untagged: false,
      truncated: false,
      members: [],
      model: { ...emptyModel([motion()]), meeting_date: "2024-03-19" },
    });
    expect(disagreed.record_date).toBe(20240318);
    expect(disagreed.meeting_date).toBe("2024-03-19");
    expect(disagreed.date_disagrees).toBe(true);
    expect(disagreed.review_status).toBe("needs_review");
    expect(disagreed.motions[0].validation_status).toBe("needs_review");
  });
});

describe("draft versus approved dedupe", () => {
  it("keeps the approved minutes and points the draft at them", () => {
    const decisions = dedupeMeetings([
      { id: "file-draft", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "draft" },
      { id: "file-approved", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "approved" },
    ]);
    const draft = decisions.find((decision) => decision.id === "file-draft");
    const approved = decisions.find((decision) => decision.id === "file-approved");
    expect(approved).toMatchObject({ superseded_by: null, review_status: "ok" });
    expect(draft).toMatchObject({ superseded_by: "file-approved", review_status: "ok" });
  });

  it("holds both files when two approved minutes exist for the same date", () => {
    const decisions = dedupeMeetings([
      { id: "file-a", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "approved" },
      { id: "file-b", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "approved" },
    ]);
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) {
      expect(decision.superseded_by).toBeNull();
      expect(decision.review_status).toBe("needs_review");
    }
  });

  it("ranks revised ahead of unknown and does not collapse other dates or bodies", () => {
    const decisions = dedupeMeetings([
      { id: "revised", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "revised" },
      { id: "unknown", body: "Village Board", meeting_date: "2024-03-18", minutes_status: "unknown" },
      { id: "next-month", body: "Village Board", meeting_date: "2024-04-01", minutes_status: "draft" },
      { id: "commission", body: "Plan Commission", meeting_date: "2024-03-18", minutes_status: "draft" },
    ]);
    expect(decisions.find((decision) => decision.id === "unknown")?.superseded_by).toBe("revised");
    expect(decisions.find((decision) => decision.id === "revised")?.superseded_by).toBeNull();
    expect(decisions.find((decision) => decision.id === "next-month")?.superseded_by).toBeNull();
    expect(decisions.find((decision) => decision.id === "commission")?.superseded_by).toBeNull();
    expect(decisions.find((decision) => decision.id === "next-month")?.review_status).toBe("ok");
  });

  it("hides tied approved meetings from the ok pile without deleting either file", () => {
    const base = (fileId: string): StoredMeeting => ({
      file_id: fileId,
      filename: `${fileId}.pdf`,
      record_date: 20240318,
      untagged: false,
      truncated: false,
      meeting_date: "2024-03-18",
      body: "Village Board",
      minutes_status: "approved",
      date_disagrees: false,
      review_status: "ok",
      review_note: null,
      superseded_by: null,
      error: null,
      motions: [{
        item_key: "item",
        item_number: "1",
        title: "Budget",
        motion_text: null,
        mover_raw: null,
        seconder_raw: null,
        mover_member_id: null,
        seconder_member_id: null,
        result: "passed",
        tally_aye: 1,
        tally_nay: 0,
        tally_abstain: null,
        tally_absent: null,
        tally_recused: null,
        tally_text: "1-0",
        source_page: null,
        validation_status: "ok",
        validation_note: "",
        votes: [{ raw_name: "Trustee Andrews", choice: "aye", member_id: "seed:Village Board:Andrews", match: "matched" }],
      }],
    });
    const [first, second] = applyDedupe([base("file-a"), base("file-b")]);
    expect(first.superseded_by).toBeNull();
    expect(second.superseded_by).toBeNull();
    expect(first.motions[0].validation_status).toBe("needs_review");
    expect(second.motions[0].validation_status).toBe("needs_review");
    expect(first.file_id).toBe("file-a");
    expect(second.file_id).toBe("file-b");
  });
});

describe("minutes selection and pilot spread", () => {
  it("uses the minutes attribute and falls back to the filename", () => {
    expect(classifyMinutesCandidate("minutes", "packet.pdf")).toEqual({ include: true, untagged: false });
    expect(classifyMinutesCandidate("agenda", "2024-01-01_Minutes.pdf")).toEqual({ include: false, untagged: false });
    expect(classifyMinutesCandidate("proposal", "minutes.pdf")).toEqual({ include: false, untagged: false });
    expect(classifyMinutesCandidate("study", "minutes.pdf")).toEqual({ include: false, untagged: false });
    expect(classifyMinutesCandidate(null, "2020-05-18_VillageBoard__12_Minutes.pdf")).toEqual({ include: true, untagged: true });
    expect(classifyMinutesCandidate(null, "2020-05-18_VillageBoard_Agenda.pdf")).toEqual({ include: false, untagged: false });
  });

  it("spreads a pilot across years", () => {
    const files = [
      { id: "2020-a", year: 2020 },
      { id: "2020-b", year: 2020 },
      { id: "2021-a", year: 2021 },
      { id: "2022-a", year: 2022 },
      { id: "2023-a", year: 2023 },
      { id: "2024-a", year: 2024 },
    ];
    const chosen = selectSpread(files, 5, (file) => file.year);
    expect(chosen.map((file) => file.id)).toEqual(["2020-a", "2021-a", "2022-a", "2023-a", "2024-a"]);
    expect(selectSpread(files, 6, (file) => file.year).map((file) => file.id)).toContain("2020-b");
  });
});

describe("extraction request", () => {
  it("asks gpt-4.1-mini for strict JSON on the responses endpoint", () => {
    expect(EXTRACT_MODEL).toBe("gpt-4.1-mini");
    expect(VOTE_EXTRACTION_SCHEMA.additionalProperties).toBe(false);
    const line = JSON.parse(buildBatchRequestLine("file-1", "The motion passed 6-1.")) as {
      custom_id: string;
      url: string;
      body: { model: string; text: { format: { type: string; strict: boolean } } };
    };
    expect(line.custom_id).toBe("file-1");
    expect(line.url).toBe("/v1/responses");
    expect(line.body.model).toBe("gpt-4.1-mini");
    expect(line.body.text.format).toMatchObject({ type: "json_schema", strict: true });
  });
});

describe("extract-votes script safety", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/extract-votes.ts"), "utf8");

  it("reads vector-store text, writes Supabase only with --write, and does not upload municipal files", () => {
    expect(source).toContain("vectorStores.files.content");
    expect(source.match(/openai\.files\.content\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/openai\.files\.content\(\s*fileId/);
    expect(source).not.toMatch(/uploadAndPoll|vectorStores\.files\.delete|openai\.files\.delete|vectorStores\.files\.create/);
    expect(source).toMatch(/purpose:\s*"batch"/);
    expect(source).toMatch(/if \(values\.write\)/);
    expect(source).toMatch(/attempts:\s*3/);
    expect(source).toMatch(/maxRetries:\s*2/);
    expect(source).not.toMatch(/query_votes|app\/api\/chat/);
    expect(source).toContain('"/v1/responses"');
  });
});
