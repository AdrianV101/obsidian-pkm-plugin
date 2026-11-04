import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuseRankings } from "../search-fusion.js";

describe("fuseRankings", () => {
  it("S1: orders by reciprocal rank fusion, ties broken by path", () => {
    // k = 60: a in both lists at ranks 1 and 3; b ranks 2 and 1; c, d, e single-list hits.
    const vector = ["a", "b", "c"];
    const keyword = ["b", "d", "a", "e"];
    const fused = fuseRankings([vector, keyword], { k: 60 });
    assert.deepEqual(fused.map(f => f.path), ["b", "a", "d", "c", "e"]);
    assert.deepEqual(fused.map(f => f.rank), [1, 2, 3, 4, 5]);
  });

  it("S1: equal scores sort by path", () => {
    const fused = fuseRankings([["z", "a"], ["a", "z"]]);
    assert.deepEqual(fused.map(f => f.path), ["a", "z"]);
    const single = fuseRankings([["m"], ["c"]]);
    assert.deepEqual(single.map(f => f.path), ["c", "m"]);
  });

  it("S1: accepts result objects and ignores empty lists", () => {
    const fused = fuseRankings([[{ path: "x" }], [], [{ path: "y" }, { path: "x" }]]);
    assert.deepEqual(fused.map(f => f.path), ["x", "y"]);
    assert.deepEqual(fuseRankings([[], []]), []);
  });

  it("S1: a smaller k favours top ranks more", () => {
    const lists = [["a", "b"], ["c", "b"], ["d", "b"]];
    assert.equal(fuseRankings(lists, { k: 60 })[0].path, "b");
    assert.equal(fuseRankings(lists, { k: 1 })[0].path, "b");
    assert.equal(fuseRankings([["a", "b"], ["c", "b"]], { k: 0 })[0].path, "a");
  });
});
