import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDisabledMessage,
  describeHealth,
  formatCoverageLine,
  formatCoverageFooter,
  healthFromStats,
} from "../semantic-health.js";

const QUOTA_REASON = "OpenAI quota exhausted. Add credits; it re-enables automatically.";
const disabled = { status: "disabled", reason: QUOTA_REASON, since: "2026-07-03T09:12:00.000Z", staleFiles: 1734, lastSuccessAt: "2026-07-02T22:00:00.000Z" };

describe("formatDisabledMessage", () => {
  it("states the day the index was disabled and why", () => {
    assert.equal(
      formatDisabledMessage(disabled),
      "Semantic search disabled since 2026-07-03: OpenAI quota exhausted. Add credits; it re-enables automatically."
    );
  });
});

describe("describeHealth", () => {
  const cases = [
    { name: "ok", health: { status: "ok", reason: null, since: null, staleFiles: 0, lastSuccessAt: null }, text: "ok" },
    { name: "ok with one stale note", health: { status: "ok", reason: null, since: null, staleFiles: 1, lastSuccessAt: null }, text: "ok, 1 note stale" },
    { name: "syncing with stale notes", health: { status: "syncing", reason: null, since: null, staleFiles: 3, lastSuccessAt: null }, text: "syncing, 3 notes stale" },
    { name: "disabled", health: disabled, text: `disabled since 2026-07-03 (${QUOTA_REASON}), 1734 notes stale` },
  ];
  for (const c of cases) {
    it(`renders ${c.name}`, () => {
      assert.equal(describeHealth(c.health), c.text);
    });
  }
});

const cov = (over) => ({ status: "ok", reason: null, since: null, staleFiles: 0, lastSuccessAt: null, notesTotal: 2550, notesEmbedded: 2103, chunksWaiting: 0, ...over });

describe("formatCoverageLine", () => {
  const cases = [
    { name: "incomplete coverage", health: cov({}), line: "Semantic index: 2103 of 2550 notes embedded" },
    { name: "incomplete with waiting chunks", health: cov({ chunksWaiting: 41 }), line: "Semantic index: 2103 of 2550 notes embedded; 41 chunks waiting" },
    { name: "complete but chunks waiting", health: cov({ notesEmbedded: 2550, chunksWaiting: 3 }), line: "Semantic index: 2550 of 2550 notes embedded; 3 chunks waiting" },
    { name: "complete and enabled", health: cov({ notesEmbedded: 2550 }), line: null },
    { name: "complete while syncing", health: cov({ status: "syncing", notesEmbedded: 2550 }), line: null },
    { name: "complete but disabled", health: cov({ status: "disabled", reason: QUOTA_REASON, since: disabled.since, notesEmbedded: 2550 }), line: "Semantic index: 2550 of 2550 notes embedded" },
    { name: "counts not reported yet", health: cov({ notesTotal: null, notesEmbedded: null }), line: null },
    { name: "old-format health without the coverage fields", health: disabled, line: null },
  ];
  for (const c of cases) {
    it(`gives ${c.line ?? "nothing"} for ${c.name}`, () => {
      assert.equal(formatCoverageLine(c.health), c.line);
    });
  }

  it("the footer is the line after a blank line, or empty", () => {
    assert.equal(formatCoverageFooter(cov({})), "\n\nSemantic index: 2103 of 2550 notes embedded");
    assert.equal(formatCoverageFooter(cov({ notesEmbedded: 2550 })), "");
  });
});

describe("healthFromStats", () => {
  const cases = [
    {
      name: "a health-aware stats file",
      stats: { indexed_files: 735, vault_files: 2469, status: "disabled", reason: QUOTA_REASON, since: disabled.since, last_success_at: disabled.lastSuccessAt, stale_files: 1734, updated_at: "2026-10-13T08:00:00.000Z" },
      health: { ...disabled, notesTotal: null, notesEmbedded: null, chunksWaiting: 0, oldestWaitSince: null, sharedCache: null },
    },
    { name: "a stats file written before health reporting", stats: { indexed_files: 42, total_chunks: 100, vault_files: 50, last_sync: null }, health: null },
    { name: "no stats", stats: null, health: null },
    {
      name: "a stats file with coverage fields",
      stats: { status: "ok", stale_files: 5, notes_total: 100, notes_embedded: 90, chunks_waiting: 7, oldest_wait_since: "2026-10-13T07:00:00.000Z", shared_cache: false },
      health: { status: "ok", reason: null, since: null, staleFiles: 5, lastSuccessAt: null, notesTotal: 100, notesEmbedded: 90, chunksWaiting: 7, oldestWaitSince: "2026-10-13T07:00:00.000Z", sharedCache: false },
    },
  ];
  for (const c of cases) {
    it(`maps ${c.name}`, () => {
      assert.deepEqual(healthFromStats(c.stats), c.health);
    });
  }
});
