import { z } from "zod";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Api = (method: "GET" | "POST", path: string, body?: object) => Promise<unknown>;
const sessionSchema = z.object({ data: z.object({ id: z.string(), location: z.object({ directory: z.string() }) }) });
const receiptSchema = z.object({ data: z.object({ id: z.string(), sessionID: z.string(),
  type: z.literal("synthetic"), payload: z.object({ text: z.string() }) }) });
const pendingSchema = z.object({ id: z.string(), sessionID: z.string(), type: z.literal("synthetic"), payload: z.object({ text: z.string() }) });
const messageSchema = z.object({ data: z.object({ id: z.string(), type: z.literal("synthetic"), text: z.string() }) });
const resultSchema = z.object({ result: z.enum(["passed", "stopped"]), phase: z.string().optional(),
  completed_publications: z.number().int().nonnegative().optional(), publications: z.number().int().nonnegative().optional(),
  measurement: z.enum(["complete", "incomplete", "not_measured"]).optional(),
  reason_code: z.enum(["observation_timeout", "observation_unverified", "native_invocation_failed", "trial_check_unverified"]).optional() });

function save(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

async function localApi(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
  const child = Bun.spawn(["opencode", "api", method.toLowerCase(), path, ...(body ? ["--data", JSON.stringify(body)] : [])], {
    stdout: "pipe", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code) throw new Error("OpenCode notification API did not acknowledge the request");
    return JSON.parse(text) as unknown;
  } finally { clearTimeout(timer); }
}

export class OpenCodeTrialNotifier {
  constructor(private readonly sessionId: string, private readonly directory: string, private readonly api: Api = localApi) {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("An explicit originating OpenCode session is required");
  }
  async verify(): Promise<void> {
    const response = sessionSchema.parse(await this.api("GET", `/api/session/${this.sessionId}`));
    if (response.data.id !== this.sessionId || resolve(response.data.location.directory) !== resolve(this.directory)) {
      throw new Error("OpenCode notification target differs from the originating project/session");
    }
  }
  async send(id: string, text: string): Promise<void> {
    if (!/^msg_[A-Za-z0-9]+$/.test(id)) throw new Error("Notification identity is invalid");
    await this.verify();
    try {
      const receipt = receiptSchema.parse(await this.api("POST", `/api/session/${this.sessionId}/synthetic`,
        { id, text, description: "Detached test notification", delivery: "queue", resume: true }));
      if (receipt.data.id !== id || receipt.data.sessionID !== this.sessionId || receipt.data.payload.text !== text) {
        throw new Error("OpenCode notification acknowledgment differs from its exact identity");
      }
      return;
    } catch {
      const inbox = z.object({ data: z.array(z.unknown()) }).parse(await this.api("GET", `/api/session/${this.sessionId}/inbox`));
      for (const entry of inbox.data) {
        const pending = pendingSchema.safeParse(entry);
        if (pending.success && pending.data.id === id && pending.data.sessionID === this.sessionId && pending.data.payload.text === text) return;
      }
      const delivered = messageSchema.parse(await this.api("GET", `/api/session/${this.sessionId}/message/${id}`));
      if (delivered.data.id !== id || delivered.data.text !== text) throw new Error("Notification delivery remains unconfirmed");
    }
  }
}

export type TrialSupervisorOptions = {
  evidence: string;
  cwd: string;
  command: string[];
  notifier: Pick<OpenCodeTrialNotifier, "verify" | "send">;
  checkIntervalMs?: number;
  stalledAfterMs?: number;
};

export async function superviseTrial(options: TrialSupervisorOptions): Promise<number> {
  const evidence = resolve(options.evidence);
  const readyFile = join(evidence, "supervisor-ready.json");
  if (existsSync(readyFile)) throw new Error("Preserve the existing trial; a supervisor must never relaunch it");
  await options.notifier.verify();
  const outbox: Array<{ id: string; kind: string; text: string; state: string }> = [];
  const notify = async (kind: string, text: string): Promise<void> => {
    const entry = { id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, kind, text, state: "pending" };
    outbox.push(entry); save(join(evidence, "notification-outbox.json"), outbox);
    try { await options.notifier.send(entry.id, text); entry.state = "acknowledged"; }
    catch { entry.state = "unconfirmed"; }
    save(join(evidence, "notification-outbox.json"), outbox);
  };
  const relative = evidence.startsWith(resolve(options.cwd) + "/") ? evidence.slice(resolve(options.cwd).length + 1) : evidence;
  writeFileSync(readyFile, JSON.stringify({ pid: process.pid, armed_at: new Date().toISOString(), notification_target_verified: true }),
    { flag: "wx", mode: 0o600 });
  const stdout = Bun.file(join(evidence, "runner.stdout.log")), stderr = Bun.file(join(evidence, "runner.stderr.log"));
  const child = Bun.spawn(options.command, { cwd: options.cwd, stdout, stderr });
  let checking = false, stalled = false, observationFailed = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      save(join(evidence, "supervisor-heartbeat.json"), { at: new Date().toISOString(), pid: process.pid, runner_pid: child.pid });
      const current = join(evidence, "current-command.json");
      if (!stalled && existsSync(current)) {
        const value = z.object({ state: z.string(), at: z.iso.datetime() }).safeParse(JSON.parse(readFileSync(current, "utf8")));
        if (value.success && value.data.state === "requested" && Date.now() - Date.parse(value.data.at) > (options.stalledAfterMs ?? 900000)) {
          stalled = true;
          await notify("stalled", `試験のコマンドが長時間未完了です。証跡: ${relative}。実行中のCLI/IOを停止・再送・強制解除せず、読み取りで状況を確認してください。`);
        }
      }
    })().catch(async () => {
      if (observationFailed) return;
      observationFailed = true;
      await notify("observation_failed", `試験の進捗監視で読取エラーを検知しました。証跡: ${relative}。実行中の処理を強制終了せず確認してください。`);
    }).finally(() => { checking = false; });
  }, options.checkIntervalMs ?? 30000);
  let code: number;
  try { code = await child.exited; }
  finally { clearInterval(timer); }
  while (checking) await Bun.sleep(10);
  const file = join(evidence, "run-result.json");
  let source: unknown;
  try { source = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as unknown : undefined; }
  catch { source = undefined; }
  const terminal = resultSchema.safeParse(source);
  const passed = code === 0 && terminal?.success === true && terminal.data.result === "passed";
  const completed = terminal?.success ? terminal.data.completed_publications ?? terminal.data.publications : undefined;
  const measurement = terminal.success ? terminal.data.measurement : undefined;
  const reason = terminal.success ? terminal.data.reason_code : undefined;
  const text = `試験${passed ? "完了" : "異常停止"}を検知しました。CLI exit=${code}、公開完了=${completed ?? "未確認"}件。証跡: ${relative}。` +
    (measurement ? `測定証跡=${measurement === "complete" ? "取得完了" : measurement === "incomplete" ? "欠測あり" : "未測定"}。` : "") +
    (reason ? `停止分類=${reason}。` : "") +
    "結果・stderr・通知outboxを確認して報告してください。これは通知であり、再実行・再送・強制解除の許可ではありません。";
  await notify(passed ? "passed" : "stopped", text);
  const exitCode = passed && outbox.every((entry) => entry.state === "acknowledged") ? 0 : code || 1;
  save(join(evidence, "supervisor-result.json"), { at: new Date().toISOString(), runner_exit_code: code,
    exit_code: exitCode, terminal_verified: terminal?.success === true, measurement: measurement ?? "unspecified", reason_code: reason,
    notification_acknowledged: outbox.every((entry) => entry.state === "acknowledged") });
  return exitCode;
}
