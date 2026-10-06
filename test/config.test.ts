import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadConfig, sharedConfigDir } from "../src/config.ts";

const defaults: Record<string, unknown> = { enabled: true, jev: { model: "jev-latest", timeoutMs: 1500 }, list: ["a"] };

/** Fresh temp dirs for the shared user, pi user and project locations, with the env pointed at them. */
function setup() {
  const root = mkdtempSync("/tmp/config-");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  return { cwd, root };
}

function write(file: string, content: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

test("shared user, pi user, shared project, pi project: each merged on top of the last", () => {
  const { cwd, root } = setup();
  const files: Array<[string, Record<string, unknown>]> = [
    [path.join(root, "xdg", "agents", "x.json"), { source: "shared-user", jev: { model: "shared" }, list: ["b"] }],
    [path.join(root, "pi", "x.json"), { source: "pi-user", jev: { timeoutMs: 2 } }],
    [path.join(cwd, ".agents", "x.json"), { source: "shared-project", list: ["c", "d"] }],
    [path.join(cwd, ".pi", "x.json"), { source: "pi-project" }],
  ];
  expect(loadConfig("x", defaults, cwd)).toEqual(defaults);
  for (const [file, value] of files) {
    write(file, value);
    expect(loadConfig("x", defaults, cwd).source).toBe(value.source);
  }
  expect(loadConfig("x", defaults, cwd)).toEqual({
    enabled: true,
    jev: { model: "shared", timeoutMs: 2 },
    list: ["c", "d"],
    source: "pi-project",
  });
});

test("invalid files are skipped and unknown keys kept", () => {
  const { cwd, root } = setup();
  write(path.join(root, "xdg", "agents", "x.json"), { enabled: false, other: { harness: "opencode" } });
  write(path.join(root, "pi", "x.json"), "{ not json");
  write(path.join(cwd, ".agents", "x.json"), "[1, 2]");
  expect(loadConfig("x", defaults, cwd)).toEqual({ ...defaults, enabled: false, other: { harness: "opencode" } });
});

test("sharedConfigDir honors XDG_CONFIG_HOME and defaults to ~/.config/agents", () => {
  process.env.XDG_CONFIG_HOME = "/tmp/xdg";
  expect(sharedConfigDir()).toBe(path.join("/tmp/xdg", "agents"));
  delete process.env.XDG_CONFIG_HOME;
  expect(sharedConfigDir()).toBe(path.join(homedir(), ".config", "agents"));
});
