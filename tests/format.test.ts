import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCount } from "../src/format.js";

describe("formatCount", () => {
  it("returns raw number under 1000", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(1), "1");
    assert.equal(formatCount(42), "42");
    assert.equal(formatCount(999), "999");
  });

  it("formats thousands with one decimal when < 10k", () => {
    assert.equal(formatCount(1000), "1.0k");
    assert.equal(formatCount(1500), "1.5k");
    assert.equal(formatCount(9999), "10.0k");
  });

  it("formats thousands without decimal when >= 10k", () => {
    assert.equal(formatCount(10_000), "10k");
    assert.equal(formatCount(12_345), "12k");
    assert.equal(formatCount(99_999), "100k");
  });

  it("formats millions with one decimal", () => {
    assert.equal(formatCount(1_000_000), "1.0m");
    assert.equal(formatCount(1_500_000), "1.5m");
    assert.equal(formatCount(12_345_678), "12.3m");
  });
});
