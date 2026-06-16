import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfirmStop,
  loadSettings,
  resolvedSettings,
  saveSettings,
  setConfirmStop,
} from "../src/settings.js";

describe("settings", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(tmpdir(), `pi-monitor-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("loadSettings", () => {
    it("returns empty object when no settings file exists", () => {
      const settings = loadSettings(cwd);
      assert.deepEqual(settings, {});
    });

    it("loads project-local settings", () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "pi-monitor.json"), JSON.stringify({ confirmStop: false }));
      const settings = loadSettings(cwd);
      assert.equal(settings.confirmStop, false);
    });

    it("warns and proceeds when settings file is malformed", () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "pi-monitor.json"), "not json");
      const settings = loadSettings(cwd);
      assert.deepEqual(settings, {});
    });

    it("warns and proceeds when settings is not an object", () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "pi-monitor.json"), JSON.stringify([1, 2, 3]));
      const settings = loadSettings(cwd);
      assert.deepEqual(settings, {});
    });
  });

  describe("resolvedSettings", () => {
    it("applies defaults when no settings file exists", () => {
      const settings = resolvedSettings(cwd);
      assert.equal(settings.confirmStop, true);
    });

    it("uses persisted value when present", () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "pi-monitor.json"), JSON.stringify({ confirmStop: false }));
      const settings = resolvedSettings(cwd);
      assert.equal(settings.confirmStop, false);
    });

    it("falls back to default when persisted value is not a boolean", () => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "pi-monitor.json"), JSON.stringify({ confirmStop: "yes" }));
      const settings = resolvedSettings(cwd);
      assert.equal(settings.confirmStop, true);
    });
  });

  describe("saveSettings", () => {
    it("writes JSON to the project-local file", () => {
      const ok = saveSettings({ confirmStop: false }, cwd);
      assert.equal(ok, true);
      assert.equal(existsSync(join(cwd, ".pi", "pi-monitor.json")), true);
      const written = JSON.parse(readFileSync(join(cwd, ".pi", "pi-monitor.json"), "utf-8"));
      assert.deepEqual(written, { confirmStop: false });
    });

    it("creates .pi directory if missing", () => {
      const ok = saveSettings({ confirmStop: true }, cwd);
      assert.equal(ok, true);
      assert.equal(existsSync(join(cwd, ".pi")), true);
    });
  });

  describe("getConfirmStop / setConfirmStop", () => {
    it("getConfirmStop returns default when no settings file", () => {
      assert.equal(getConfirmStop(cwd), true);
    });

    it("setConfirmStop persists and getConfirmStop reads it", () => {
      const ok = setConfirmStop(false, cwd);
      assert.equal(ok, true);
      assert.equal(getConfirmStop(cwd), false);
    });

    it("setConfirmStop persists the updated value", () => {
      saveSettings({ confirmStop: false }, cwd);
      setConfirmStop(true, cwd);
      const reloaded = loadSettings(cwd);
      assert.equal(reloaded.confirmStop, true);
    });
  });
});
