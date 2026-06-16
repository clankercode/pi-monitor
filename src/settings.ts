/**
 * pi-monitor extension settings.
 *
 * Persisted as JSON in either the project-local config (`<cwd>/.pi/pi-monitor.json`)
 * or the global config (`~/.pi/agent/pi-monitor.json`). Project overrides global.
 *
 * Currently exposes a single knob: `confirmStop` (default `true`) — whether the
 * interactive /monitor-list menu asks for confirmation before ending a monitor.
 *
 * Patterned after pi-subagents' settings.ts so the load/save/merge shape stays
 * familiar: missing file is silent, malformed file warns and proceeds, project
 * file overrides global file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface PiMonitorSettings {
  /** Whether /monitor-list asks for confirmation before stopping a monitor. */
  confirmStop?: boolean;
}

const DEFAULTS: Required<PiMonitorSettings> = {
  confirmStop: true,
};

const SETTINGS_FILENAME = "pi-monitor.json";

function globalPath(): string {
  return join(getAgentDir(), SETTINGS_FILENAME);
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_FILENAME);
}

function readJsonFile(path: string): PiMonitorSettings {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PiMonitorSettings;
    }
    console.warn(`[pi-monitor] Ignoring malformed settings at ${path}: not an object`);
    return {};
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-monitor] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): PiMonitorSettings {
  return { ...readJsonFile(globalPath()), ...readJsonFile(projectPath(cwd)) };
}

/** Resolved settings with defaults applied. */
export function resolvedSettings(cwd: string = process.cwd()): Required<PiMonitorSettings> {
  const loaded = loadSettings(cwd);
  return {
    confirmStop: typeof loaded.confirmStop === "boolean" ? loaded.confirmStop : DEFAULTS.confirmStop,
  };
}

/** Persist the full settings snapshot to the project-local file. */
export function saveSettings(s: PiMonitorSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-monitor] Failed to save settings at ${path}: ${reason}`);
    return false;
  }
}

/** Returns the current value of `confirmStop`, applying default if unset. */
export function getConfirmStop(cwd: string = process.cwd()): boolean {
  return resolvedSettings(cwd).confirmStop;
}

/**
 * Update `confirmStop` and persist. Returns the save outcome so the UI can
 * surface a warning toast on persistence failure.
 */
export function setConfirmStop(value: boolean, cwd: string = process.cwd()): boolean {
  const current = loadSettings(cwd);
  return saveSettings({ ...current, confirmStop: value }, cwd);
}
