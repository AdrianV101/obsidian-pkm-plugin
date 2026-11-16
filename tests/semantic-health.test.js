import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDisabledMessage,
  describeHealth,
  formatStaleFooter,
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

describe("formatStaleFooter", () => {
  const cases = [
    { n: 0, text: "" },
    { n: 1, text: "\n\n*1 note has changed since last indexed; results may be stale.*" },
    { n: 2, text: "\n\n*2 notes have changed since last indexed; results may be stale.*" },
  ];
  for (const c of cases) {
    it(`renders ${c.n} stale notes`, () => {
      assert.equal(formatStaleFooter(c.n), c.text);
    });
  }
});

describe("healthFromStats", () => {
  const cases = [
    {
      name: "a health-aware stats file",
      stats: { indexed_files: 735, vault_files: 2469, status: "disabled", reason: QUOTA_REASON, since: disabled.since, last_success_at: disabled.lastSuccessAt, stale_files: 1734, updated_at: "2026-10-13T08:00:00.000Z" },
      health: disabled,
    },
    { name: "a stats file written before health reporting", stats: { indexed_files: 42, total_chunks: 100, vault_files: 50, last_sync: null }, health: null },
    { name: "no stats", stats: null, health: null },
  ];
  for (const c of cases) {
    it(`maps ${c.name}`, () => {
      assert.deepEqual(healthFromStats(c.stats), c.health);
    });
  }
});
