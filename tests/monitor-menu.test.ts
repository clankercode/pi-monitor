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

interface Harness {
  press: (key: string) => Promise<void>;
  render: () => string[];
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
  setConfirmResult: (v: boolean) => void;
  setConfirmStop: (v: boolean) => void;
  lastConfirmPrompt: () => { title: string; message: string } | undefined;
  notifications: () => Array<{ message: string; type: "info" | "warning" | "error" | undefined }>;
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
  let confirmResult = true;
  let confirmStop = true;
  let lastConfirm: { title: string; message: string } | undefined;
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
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
        lastConfirm = { title, message };
        return confirmResult;
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
    onCancel: async (jobID: string) => {
      cancels.push(jobID);
      currentMonitors = currentMonitors.filter((m) => m.id !== jobID);
      return `${jobID} cancelled`;
    },
  };

  for (const m of monitors) {
    tailData.set(m.id, ["line 1", "line 2", "line 3"]);
  }

  // Fire-and-forget.
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
    setConfirmResult: (v: boolean) => {
      confirmResult = v;
    },
    setConfirmStop: (v: boolean) => {
      confirmStop = v;
    },
    lastConfirmPrompt: () => lastConfirm,
    notifications: () => notifications.slice(),
    cancels: () => cancels.slice(),
    tails: () => tails.slice(),
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("monitor-menu", () => {
  // Each test creates a harness whose menu starts a setInterval. We
  // dispose the component after every test so the interval doesn't
  // keep the event loop alive.
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
    assert.ok(text.includes("Monitor List (2 running)"), "title not in render");
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

  it("'x' hotkey stops the selected monitor without confirm", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    await h.press("x");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_1"]);
    assert.equal(h.lastConfirmPrompt(), undefined, "confirm should not be called for 'x'");
  });

  it("Enter hotkey asks for confirm when getConfirmStop is true and user declines", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setConfirmResult(false);
    await h.press("\r");
    await h.flush();
    assert.notEqual(h.lastConfirmPrompt(), undefined, "confirm should be called");
    assert.deepEqual(h.cancels(), [], "should not stop when user declines");
  });

  it("Enter hotkey stops when user confirms", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setConfirmResult(true);
    await h.press("\r");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_1"]);
  });

  it("Enter hotkey skips confirm when getConfirmStop is false", async () => {
    const h = await makeReady([
      { id: "mon_1", command: "echo 1", regex: ".*", startedAt: 1 },
    ]);
    h.setConfirmStop(false);
    await h.press("\r");
    await h.flush();
    assert.deepEqual(h.cancels(), ["mon_1"]);
    assert.equal(h.lastConfirmPrompt(), undefined, "confirm should not be called when confirmStop=false");
  });

  it("Esc hotkey closes the menu (does not stop)", async () => {
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

  it("stops the selected monitor after navigating down", async () => {
    const h = await makeReady([
      { id: "mon_old", command: "echo old", regex: ".*", startedAt: 1 },
      { id: "mon_new", command: "echo new", regex: ".*", startedAt: 100 },
    ]);
    // Newest first: mon_new is initially selected. Move down to mon_old.
    await h.press("\x1b[B");
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
