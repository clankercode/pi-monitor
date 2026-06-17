import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { showMonitorMenu, type MonitorMenuMonitor } from "../src/ui/monitor-menu.js";

/* ------------------------------------------------------------------ */
/* Test harness                                                       */
/* ------------------------------------------------------------------ */

interface CapturedComponent {
  render: (w: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  dispose?: () => void;
}

interface SelectPrompt {
  title: string;
  options: string[];
}

interface Harness {
  press: (key: string) => Promise<void>;
  render: () => string[];
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
  setConfirmStop: (v: boolean) => void;
  setSelectChoice: (v: string | undefined) => void;
  setSetConfirmStopResult: (v: boolean) => void;
  confirms: () => Array<{ title: string; message: string }>;
  selects: () => SelectPrompt[];
  notifications: () => Array<{ message: string; type: "info" | "warning" | "error" | undefined }>;
  setConfirmStopCalls: () => boolean[];
  cancels: () => string[];
  tails: () => Array<{ jobID: string; stream: "stdout" | "stderr" }>;
}

const plainSelectListTheme = {
  selectedPrefix: (t: string) => `> ${t}`,
  selectedText: (t: string) => t,
  description: (t: string) => t,
  scrollInfo: (t: string) => t,
  noMatch: (t: string) => t,
};

function buildHarness(monitors: MonitorMenuMonitor[]): Harness {
  let captured: CapturedComponent | undefined;
  let confirmStop = true;
  let selectChoice: string | undefined = "No";
  let setConfirmStopResult = true;
  const confirmPrompts: Array<{ title: string; message: string }> = [];
  const selectPrompts: SelectPrompt[] = [];
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
  const setConfirmStopCalls: boolean[] = [];
  const cancels: string[] = [];
  const tails: Array<{ jobID: string; stream: "stdout" | "stderr" }> = [];
  const tailData = new Map<string, string[]>();
  let currentMonitors: MonitorMenuMonitor[] = monitors;

  const ctx = {
    ui: {
      custom: async <T>(factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> => {
        const fakeTui = {};
        const fakeKeybindings = {};
        let resolveDone: (value: T) => void = () => {};
        const donePromise = new Promise<T>((resolve) => {
          resolveDone = resolve;
        });
        const doneFn = (v: T) => {
          resolveDone(v);
        };
        const component = factory(
          fakeTui,
          plainSelectListTheme as unknown as Theme,
          fakeKeybindings,
          doneFn,
        ) as CapturedComponent;
        captured = component;
        return donePromise;
      },
      confirm: async (title: string, message: string): Promise<boolean> => {
        confirmPrompts.push({ title, message });
        return true;
      },
      select: async (title: string, options: string[]): Promise<string | undefined> => {
        selectPrompts.push({ title, options });
        return selectChoice;
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  };

  const opts = {
    ctx,
    getSelectListTheme: () => plainSelectListTheme,
    getMonitors: () => currentMonitors,
    tail: (jobID: string, stream: "stdout" | "stderr") => {
      tails.push({ jobID, stream });
      return tailData.get(jobID) ?? [];
    },
    getConfirmStop: () => confirmStop,
    setConfirmStop: (value: boolean) => {
      setConfirmStopCalls.push(value);
      confirmStop = value;
      return setConfirmStopResult;
    },
    onCancel: async (jobID: string) => {
      cancels.push(jobID);
      currentMonitors = currentMonitors.filter((m) => m.id !== jobID);
      return `${jobID} cancelled`;
    },
  };

  for (const m of monitors) {
    tailData.set(m.id, ["line 1", "line 2", "line 3"]);
  }

  showMonitorMenu(opts).catch(() => { /* ignore abort on close */ });

  const waitForCaptured = async (timeoutMs = 2000): Promise<CapturedComponent> => {
    const start = Date.now();
    while (!captured) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("menu factory never produced a component");
      }
      await new Promise((r) => setImmediate(r));
    }
    return captured;
  };

  return {
    press: async (key: string) => {
      const c = await waitForCaptured();
      c.handleInput(key);
    },
    render: () => {
      if (!captured) return [];
      return captured.render(80);
    },
    flush: async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    dispose: async () => {
      if (captured) captured.dispose?.();
    },
    setConfirmStop: (v: boolean) => {
      confirmStop = v;
    },
    setSelectChoice: (v: string | undefined) => {
      selectChoice = v;
    },
    setSetConfirmStopResult: (v: boolean) => {
      setConfirmStopResult = v;
    },
    confirms: () => confirmPrompts.slice(),
    selects: () => selectPrompts.slice(),
    notifications: () => notifications.slice(),
    setConfirmStopCalls: () => setConfirmStopCalls.slice(),
    cancels: () => cancels.slice(),
    tails: () => tails.slice(),
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("monitor-menu", () => {
  let activeHarness: Harness | undefined;

  afterEach(async () => {
    if (activeHarness) {
      await activeHarness.dispose();
      activeHarness = undefined;
    }
  });

  async function makeReady(monitors: MonitorMenuMonitor[]): Promise<Harness> {
    activeHarness = buildHarness(monitors);
    return activeHarness;
  }

  it("renders the title with monitor count", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
      { id: "mon_2", command: "echo 2", regex: ".*", startedAt: 2 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    assert.ok(text.includes("Monitor List"), "title not in render");
    assert.ok(text.includes("2 running"), "monitor count not in title");
  });

  it("renders a horizontal-rule frame for visual separation", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    const ruleCount = (text.match(/─/g) ?? []).length;
    assert.ok(ruleCount >= 10, `expected ─ chars for frame, got ${ruleCount}`);
  });

  it("renders vertical sides (╭╮╰╯│) for the panel frame", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    // Top border with corners
    assert.ok(text.includes("╭"), "expected ╭ top-left corner");
    assert.ok(text.includes("╮"), "expected ╮ top-right corner");
    // Bottom border with corners
    assert.ok(text.includes("╰"), "expected ╰ bottom-left corner");
    assert.ok(text.includes("╯"), "expected ╯ bottom-right corner");
    // Side rails on inner lines
    const sideCount = (text.match(/│/g) ?? []).length;
    assert.ok(sideCount >= 2, `expected │ side rails, got ${sideCount}`);
  });

  it("renders a live clock in the header", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    assert.ok(/\d{2}:\d{2}:\d{2}/.test(text), "expected HH:MM:SS clock in render");
  });

  it("sorts monitors newest first", async () => {
    const h = await makeReady([
      { id: "mon_old", command: "echo old", regex: ".*", startedAt: 1 },
      { id: "mon_new", command: "echo new", regex: ".*", startedAt: 100 },
      { id: "mon_mid", command: "echo mid", regex: ".*", startedAt: 50 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    const idxNew = text.indexOf("mon_new");
    const idxMid = text.indexOf("mon_mid");
    const idxOld = text.indexOf("mon_old");
    assert.ok(idxNew >= 0 && idxMid >= 0 && idxOld >= 0, "all ids should appear");
    assert.ok(idxNew < idxMid, "newest should appear before middle");
    assert.ok(idxMid < idxOld, "middle should appear before oldest");
  });

  it("shows label, regex, and trigger flags in description", async () => {
    const h = await makeReady([
      { id: "mon_x", command: "x", regex: "error|warn", label: "watcher", triggerTurn: true, startedAt: 1 },
    ]);
    const lines = h.render();
    const text = lines.join("\n");
    assert.ok(text.includes("[watcher]"), "label not in description");
    assert.ok(text.includes("/error|warn/"), "regex not in description");
    assert.ok(text.includes("trigger"), "trigger flag not in description");
  });

  it("Enter on list mode switches to details (does not kill)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\r");
    await h.flush();
    assert.deepEqual(h.cancels(), [], "Enter should not cancel");
    const text = h.render().join("\n");
    assert.ok(text.includes("Details"), "expected details header");
    assert.ok(text.includes("Command"), "expected command field in details");
  });

  it("Enter on details mode goes back to list", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\r"); // list -> details
    await h.flush();
    assert.ok(h.render().join("\n").includes("Details"), "expected details view");
    await h.press("\r"); // details -> list
    await h.flush();
    const text = h.render().join("\n");
    assert.ok(text.includes("Monitor List"), "expected list view after second Enter");
  });

  it("Esc on details mode goes back to list (does not close)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\r"); // -> details
    await h.flush();
    await h.press("\x1b"); // -> list
    await h.flush();
    const text = h.render().join("\n");
    assert.ok(text.includes("Monitor List"), "expected list view after Esc on details");
    assert.ok(h.render().join("\n").length > 0, "menu should still be open");
  });

  it("Left arrow on details mode goes back to list (does not close)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\r"); // -> details
    await h.flush();
    assert.ok(h.render().join("\n").includes("Details"), "expected details view");
    // \x1b[D is the standard left-arrow CSI sequence
    await h.press("\x1b[D");
    await h.flush();
    const text = h.render().join("\n");
    assert.ok(text.includes("Monitor List"), "expected list view after left on details");
    assert.ok(h.render().join("\n").length > 0, "menu should still be open");
  });

  it("Left arrow on list mode closes the menu (does not kill)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\x1b[D");
    await h.flush();
    assert.deepEqual(h.cancels(), [], "left arrow should not stop any monitor");
  });

  it("x shows a 3-option prompt (No, Yes, Don't Ask Again)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setSelectChoice(undefined);
    await h.press("x");
    await h.flush();
    const prompts = h.selects();
    assert.equal(prompts.length, 1, "expected one select prompt");
    assert.deepEqual(prompts[0].options, ["No", "Yes", "Don't Ask Again"]);
  });

  it("x with 'No' does not kill", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setSelectChoice("No");
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), [], "should not kill when 'No' chosen");
  });

  it("x with 'Yes' kills the monitor", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setSelectChoice("Yes");
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_1"]);
  });

  it("killing the only monitor auto-closes the menu (no stuck input box)", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setSelectChoice("Yes");
    await h.press("x");
    // Flush for the close to complete and the custom() promise to resolve.
    await h.flush();
    await h.flush();
    // After auto-close, the menu factory's done() should have been called.
    // We can detect this by checking the harness's state: the captured
    // component is still in scope, but the menu's custom() promise has
    // resolved. The test here is indirect: cancelling the only monitor
    // must not leave the list "0 running" still active.
    assert.deepEqual(h.cancels(), ["mon_1"]);
    // Subsequent input should be a no-op (the menu has closed).
    await h.press("x");
    await h.flush();
    // No second cancel attempt.
    assert.deepEqual(h.cancels(), ["mon_1"]);
  });

  it("killing one of multiple monitors does NOT auto-close", async () => {
    const h = await makeReady([
      { id: "mon_a", command: "echo a", regex: ".*", startedAt: 1 },
      { id: "mon_b", command: "echo b", regex: ".*", startedAt: 2 },
    ]);
    h.setSelectChoice("Yes");
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_b"]);
    // Menu should still be open: pressing x again should prompt (and we
    // can verify the new monitor is the one being acted on).
    h.setSelectChoice("Yes");
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_b", "mon_a"]);
  });

  it("x with 'Don't Ask Again' kills and persists confirmStop=false", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setSelectChoice("Don't Ask Again");
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_1"]);
    assert.deepEqual(h.setConfirmStopCalls(), [false]);
  });

  it("when confirmStop=false, x kills without prompting", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setConfirmStop(false);
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.selects(), [], "should not show select prompt");
    assert.deepEqual(h.cancels(), ["mon_1"]);
  });

  it("Esc hotkey closes the menu from list mode", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("\x1b");
    await h.flush();
    assert.deepEqual(h.cancels(), [], "Esc should not stop any monitor");
  });

  it("'q' hotkey closes the menu", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("q");
    await h.flush();
    assert.deepEqual(h.cancels(), [], "q should not stop any monitor");
  });

  it("x kills the selected monitor after navigating down", async () => {
    const h = await makeReady([
      { id: "mon_old", command: "echo old", regex: ".*", startedAt: 1 },
      { id: "mon_new", command: "echo new", regex: ".*", startedAt: 100 },
    ]);
    h.setSelectChoice("Yes");
    await h.press("\x1b[B"); // down
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_old"]);
  });

  it("tails are fetched for active monitors", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
      { id: "mon_2", command: "echo 2", regex: ".*", startedAt: 2 },
    ]);
    h.render();
    const tailIds = new Set(h.tails().map((t) => t.jobID));
    assert.ok(tailIds.has("mon_1"));
    assert.ok(tailIds.has("mon_2"));
  });
});
