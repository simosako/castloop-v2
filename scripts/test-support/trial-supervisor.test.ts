import { expect, test } from "bun:test";
import { OpenCodeTrialNotifier, superviseTrial } from "./trial-supervisor";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = "/project", sessionId = "ses_test", id = "msg_test", text = "local notification";
const session = { data: { id: sessionId, location: { directory } } };
const receipt = { data: { id, sessionID: sessionId, type: "synthetic", payload: { text } } };

test("notifications target the exact session and request durable queued execution", async () => {
  const calls: Array<{ method: string; path: string; body?: object }> = [];
  const notifier = new OpenCodeTrialNotifier(sessionId, directory, async (method, path, body) => {
    calls.push({ method, path, body }); return method === "GET" ? session : receipt;
  });
  await notifier.send(id, text);
  expect(calls).toEqual([{ method: "GET", path: `/api/session/${sessionId}` },
    { method: "POST", path: `/api/session/${sessionId}/synthetic`, body: { id, text,
      description: "Detached test notification", delivery: "queue", resume: true } }]);
});

test("a lost notification response is reconciled from the inbox without reposting", async () => {
  let posts = 0;
  const notifier = new OpenCodeTrialNotifier(sessionId, directory, async (method, path) => {
    if (method === "POST") { posts++; throw new Error("response lost"); }
    return path.endsWith("/inbox") ? { data: [receipt.data] } : session;
  });
  await notifier.send(id, text); expect(posts).toBe(1);
});

test("already delivered notifications are reconciled by exact message identity", async () => {
  const notifier = new OpenCodeTrialNotifier(sessionId, directory, async (method, path) => {
    if (method === "POST") throw new Error("response lost");
    return path.endsWith("/inbox") ? { data: [] } : path.endsWith(`/message/${id}`) ?
      { data: { id, type: "synthetic", text } } : session;
  });
  await notifier.send(id, text);
});

test("wrong project blocks notification before POST", async () => {
  let posts = 0;
  const notifier = new OpenCodeTrialNotifier(sessionId, "/another", async (method) => { if (method === "POST") posts++; return session; });
  await expect(notifier.send(id, text)).rejects.toThrow("originating"); expect(posts).toBe(0);
});

async function localTrial(result: object | undefined, code: number, notifyFails = false) {
  const evidence = mkdtempSync("/tmp/opencode/trial-supervisor-test-");
  const notifications: string[] = [];
  if (result) writeFileSync(join(evidence, "fixture.json"), JSON.stringify(result));
  const script = `import {copyFileSync} from "node:fs"; if (${Boolean(result)}) copyFileSync(${JSON.stringify(join(evidence, "fixture.json"))}, ${JSON.stringify(join(evidence, "run-result.json"))}); process.exit(${code});`;
  try {
    const exit = await superviseTrial({ evidence, cwd: process.cwd(), command: [process.execPath, "--eval", script],
      notifier: { verify: async () => {}, send: async (_id, text) => { notifications.push(text); if (notifyFails) throw new Error("offline"); } } });
    return { exit, notifications, outbox: JSON.parse(readFileSync(join(evidence, "notification-outbox.json"), "utf8")),
      summary: JSON.parse(readFileSync(join(evidence, "supervisor-result.json"), "utf8")) };
  } finally { rmSync(evidence, { recursive: true, force: true }); }
}

test("nonzero CLI exit is notified and propagated instead of swallowed by a waiter", async () => {
  const result = await localTrial({ result: "stopped", completed_publications: 29 }, 1);
  expect(result.exit).toBe(1); expect(result.notifications[0]).toContain("異常停止");
  expect(result.notifications[0]).toContain("29件"); expect(result.outbox[0].state).toBe("acknowledged");
});

test("missing terminal result and a nominal zero exit are still an abnormal trial", async () => {
  const result = await localTrial(undefined, 0);
  expect(result.exit).toBe(1); expect(result.summary.terminal_verified).toBe(false); expect(result.notifications[0]).toContain("異常停止");
});

test("successful completion is notified too", async () => {
  const result = await localTrial({ result: "passed", publications: 36 }, 0);
  expect(result.exit).toBe(0); expect(result.notifications[0]).toContain("試験完了");
});

test("notification failure leaves a durable outbox and nonzero exit, without rerunning the child", async () => {
  const result = await localTrial({ result: "passed", publications: 36 }, 0, true);
  expect(result.exit).toBe(1); expect(result.outbox[0].state).toBe("unconfirmed"); expect(result.notifications.length).toBe(1);
});

test("notification preflight failure prevents runner launch", async () => {
  const evidence = mkdtempSync("/tmp/opencode/trial-supervisor-test-");
  try {
    await expect(superviseTrial({ evidence, cwd: process.cwd(), command: ["does-not-exist"],
      notifier: { verify: async () => { throw new Error("not armed"); }, send: async () => {} } })).rejects.toThrow("not armed");
  } finally { rmSync(evidence, { recursive: true, force: true }); }
});

test("a malformed terminal record is notified rather than hiding the failure", async () => {
  const evidence = mkdtempSync("/tmp/opencode/trial-supervisor-test-");
  const notifications: string[] = [];
  writeFileSync(join(evidence, "run-result.json"), "{");
  try {
    const exit = await superviseTrial({ evidence, cwd: process.cwd(), command: [process.execPath, "--eval", "process.exit(0)"],
      notifier: { verify: async () => {}, send: async (_id, text) => { notifications.push(text); } } });
    expect(exit).toBe(1); expect(notifications[0]).toContain("異常停止");
  } finally { rmSync(evidence, { recursive: true, force: true }); }
});

test("stalled work is reported without killing or replaying the runner", async () => {
  const evidence = mkdtempSync("/tmp/opencode/trial-supervisor-test-");
  const notifications: string[] = [];
  writeFileSync(join(evidence, "current-command.json"), JSON.stringify({ state: "requested", at: "2020-01-01T00:00:00Z" }));
  const script = `await Bun.sleep(100); await Bun.write(${JSON.stringify(join(evidence, "run-result.json"))}, JSON.stringify({result:"passed",publications:1}));`;
  try {
    const exit = await superviseTrial({ evidence, cwd: process.cwd(), command: [process.execPath, "--eval", script],
      checkIntervalMs: 5, stalledAfterMs: 1,
      notifier: { verify: async () => {}, send: async (_id, text) => { notifications.push(text); } } });
    expect(exit).toBe(0); expect(notifications.length).toBe(2);
    expect(notifications[0]).toContain("長時間未完了"); expect(notifications[1]).toContain("試験完了");
  } finally { rmSync(evidence, { recursive: true, force: true }); }
});

test("a retained supervisor identity blocks a second runner", async () => {
  const evidence = mkdtempSync("/tmp/opencode/trial-supervisor-test-");
  writeFileSync(join(evidence, "supervisor-ready.json"), "retained");
  let preflights = 0;
  try {
    await expect(superviseTrial({ evidence, cwd: process.cwd(), command: ["does-not-exist"], notifier: {
      verify: async () => { preflights++; }, send: async () => {},
    } })).rejects.toThrow("never relaunch");
    expect(preflights).toBe(0); expect(readFileSync(join(evidence, "supervisor-ready.json"), "utf8")).toBe("retained");
  } finally { rmSync(evidence, { recursive: true, force: true }); }
});
