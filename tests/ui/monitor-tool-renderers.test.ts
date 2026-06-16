/**
 * Tests for src/ui/monitor-tool-renderers.ts
 *
 * Validates the Monitor / MonitorStop / MonitorList tool result renderers.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  renderMonitorCall,
  renderMonitorResult,
  renderMonitorStopResult,
  renderMonitorListCall,
  renderMonitorListResult,
  formatUptime,
  type ActiveMonitorInfo,
  type MonitorDetails,
  type MonitorStopDetails,
  type MonitorListDetails,
} from "../../src/ui/monitor-tool-renderers.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// ------------------------------------------------------------------
// Identity theme — no colors, just pass-through, so we can match substrings.
// ------------------------------------------------------------------
const plainTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function collectLines(component: { render: (w: number) => string[] }, width = 200): string {
  return component.render(width).join("\n");
}

describe("renderMonitorCall", () => {
  it("shows icon, kind, label, and command", () => {
    const args: MonitorDetails = {
      command: "tail -f /var/log/app.log",
      regex: ".*",
      before: 0,
      after: 0,
      debounceSeconds: 0,
      label: "logs",
    };
    const text = collectLines(renderMonitorCall(args, plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(text.includes("logs"));
    assert.ok(text.includes("tail -f /var/log/app.log"));
  });

  it("omits label section when label is missing", () => {
    const args: MonitorDetails = {
      command: "echo hi",
      regex: ".*",
      before: 0,
      after: 0,
      debounceSeconds: 0,
    };
    const text = collectLines(renderMonitorCall(args, plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(!text.includes("· undefined"));
  });
});

describe("renderMonitorResult", () => {
  it("renders header with label", () => {
    const details: MonitorDetails = {
      command: "echo hi",
      regex: ".*",
      before: 0,
      after: 0,
      debounceSeconds: 0,
      label: "test",
    };
    const text = collectLines(renderMonitorResult(details, false, false, plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(text.includes("started"));
    assert.ok(text.includes("test"));
  });

  it("shows trigger on its own line indented 3 spaces", () => {
    const details: MonitorDetails = {
      command: "echo hi",
      regex: ".*",
      before: 0,
      after: 0,
      debounceSeconds: 0,
      triggerTurn: true,
    };
    const text = collectLines(renderMonitorResult(details, false, false, plainTheme));
    assert.ok(text.includes("trigger"), "should show trigger");
    // Find the line that contains "trigger" and check its leading indent.
    const triggerLine = text.split("\n").find((l) => l.includes("trigger"));
    assert.ok(triggerLine !== undefined, "trigger line exists");
    assert.ok(/^   trigger/.test(triggerLine!), "trigger line is indented 3 spaces");
  });

  it("hides meta lines when defaults are in use", () => {
    const details: MonitorDetails = {
      command: "echo hi",
      regex: ".*",
      before: 0,
      after: 0,
      debounceSeconds: 0,
    };
    const text = collectLines(renderMonitorResult(details, false, false, plainTheme));
    assert.ok(!text.includes("trigger"));
    assert.ok(!text.includes("/undefined/"));
    assert.ok(!text.includes("ctx:"));
    assert.ok(!text.includes("debounce:"));
  });

  it("shows regex meta when regex is not the default", () => {
    const details: MonitorDetails = {
      command: "tail -f /var/log/app.log",
      regex: "error",
      before: 0,
      after: 0,
      debounceSeconds: 0,
    };
    const text = collectLines(renderMonitorResult(details, false, false, plainTheme));
    assert.ok(text.includes("/error/"));
  });

  it("filters out undefined regex", () => {
    const details = {
      command: "echo hi",
      regex: undefined,
      before: 0,
      after: 0,
      debounceSeconds: 0,
    } as unknown as MonitorDetails;
    const text = collectLines(renderMonitorResult(details, false, false, plainTheme));
    assert.ok(!text.includes("undefined"), "should not show undefined");
    assert.ok(!text.includes("/undefined/"));
  });

  it("renders error text when error flag is set", () => {
    const text = collectLines(renderMonitorResult({ command: "x" } as MonitorDetails, true, false, plainTheme));
    assert.ok(text.includes("error"));
  });
});

describe("renderMonitorStopResult", () => {
  it("shows stopped status and id", () => {
    const details: MonitorStopDetails = { id: "mon_42" };
    const text = collectLines(renderMonitorStopResult(details, false, plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(text.includes("stopped"));
    assert.ok(text.includes("mon_42"));
  });

  it("renders error when isError is true", () => {
    const text = collectLines(renderMonitorStopResult({ id: "x" }, true, plainTheme));
    assert.ok(text.includes("error"));
  });
});

describe("renderMonitorListCall", () => {
  it("shows icon, kind, and list label", () => {
    const text = collectLines(renderMonitorListCall(plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(text.includes("list"));
  });
});

describe("renderMonitorListResult", () => {
  it("shows empty-state message when no monitors", () => {
    const text = collectLines(renderMonitorListResult({ monitors: [] }, false, plainTheme));
    assert.ok(text.includes("◈ monitor"));
    assert.ok(text.includes("list"));
    assert.ok(text.includes("no monitors running"));
  });

  it("shows header with count when monitors exist", () => {
    const monitors: ActiveMonitorInfo[] = [
      { id: "mon_1", command: "echo hi", regex: ".*", uptimeSec: 30 },
      { id: "mon_2", command: "tail -f /var/log", regex: ".*", uptimeSec: 90 },
    ];
    const text = collectLines(renderMonitorListResult({ monitors }, false, plainTheme));
    assert.ok(text.includes("2 running"), "should show count");
    assert.ok(text.includes("mon_1"));
    assert.ok(text.includes("mon_2"));
    assert.ok(text.includes("echo hi"));
    assert.ok(text.includes("30s"));
    assert.ok(text.includes("1m 30s"));
  });

  it("renders error text when error flag is set", () => {
    const text = collectLines(renderMonitorListResult({ monitors: [] }, true, plainTheme));
    assert.ok(text.includes("error"));
  });

  it("shows trigger and label meta inline when present", () => {
    const monitors: ActiveMonitorInfo[] = [
      {
        id: "mon_1",
        command: "echo hi",
        regex: ".*",
        label: "my-label",
        triggerTurn: true,
        uptimeSec: 60,
      },
    ];
    const text = collectLines(renderMonitorListResult({ monitors }, false, plainTheme));
    assert.ok(text.includes("trigger"));
    assert.ok(text.includes("[my-label]"));
  });

  it("indents each monitor line by 3 spaces", () => {
    const monitors: ActiveMonitorInfo[] = [
      { id: "mon_1", command: "echo hi", regex: ".*", uptimeSec: 5 },
    ];
    const lines = renderMonitorListResult({ monitors }, false, plainTheme).render(200);
    const monitorLine = lines.find((l) => l.includes("mon_1"));
    assert.ok(monitorLine !== undefined);
    assert.ok(/^   mon_1/.test(monitorLine!), "monitor line indented 3 spaces");
  });
});

describe("formatUptime", () => {
  it("formats seconds only", () => {
    assert.strictEqual(formatUptime(0), "0s");
    assert.strictEqual(formatUptime(45), "45s");
  });
  it("formats minutes and seconds", () => {
    assert.strictEqual(formatUptime(60), "1m 0s");
    assert.strictEqual(formatUptime(90), "1m 30s");
  });
  it("formats hours and minutes", () => {
    assert.strictEqual(formatUptime(3600), "1h 0m");
    assert.strictEqual(formatUptime(3690), "1h 1m");
  });
});
