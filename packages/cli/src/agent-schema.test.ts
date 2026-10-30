import { expect, test } from "bun:test";
import { inputSchema, resultEnvelopeSchema } from "./agent-schema";
import { agentEnvelope } from "./agent-output";
import { COMMAND_HELP, commandHelp, commandOptions, describeCommand } from "./help";

test("embedded schemas retain strict keys and measured constraints", () => {
  for (const name of ["service-config", "show-input", "episode-input"]) {
    expect(inputSchema(name)).toMatchObject({ additionalProperties: false, "x-castloop-contract-version": 1 });
  }
  expect(JSON.stringify(inputSchema("show-input"))).toContain("utf8_bytes");
  expect(inputSchema("show-input")).toMatchObject({ properties: { site_timezone: { type: "string", maxLength: 128 } } });
  expect(JSON.stringify(inputSchema("show-input"))).toContain("supported IANA time zone name");
  expect(() => inputSchema("unknown")).toThrow();
});

test("help and describe share options; failure envelopes never authorize retries", () => {
  for (const command of Object.keys(COMMAND_HELP)) {
    expect(describeCommand(command).options).toEqual(commandOptions(command));
    for (const flag of Object.keys(commandOptions(command))) expect(commandHelp(command)).toContain(`--${flag}`);
  }
  const failed = agentEnvelope("publish-episode", {}, null, new Error("private-token"), true);
  expect(resultEnvelopeSchema.safeParse(failed).success).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("private-token");
  expect(failed.error?.outcome).toBe("unknown");
  const completed = agentEnvelope("publish-episode", {}, { result: "changed", revision_id: crypto.randomUUID() });
  expect(completed.next_actions).toEqual([]); expect(completed.operation).toBeNull();
});

test("describe recovery distinguishes observation, local exports and explicit continuation", () => {
  for (const command of ["init", "create-show", "deploy"]) {
    expect(describeCommand(command).recovery).toContain("rerun");
    expect(describeCommand(command).recovery).toContain("saved inputs");
  }
  expect(describeCommand("domain").recovery).toContain("domain status UUID");
  expect(describeCommand("domain").recovery).toContain("domain continue UUID");
  expect(describeCommand("publish-rss-import").recovery).toContain("same retained batch and inputs");
  expect(describeCommand("publish-rss-import").recovery).not.toContain("Resume");
  expect(describeCommand("import-rss").recovery).toContain("same snapshot and output directory");
  for (const command of ["schedule-show", "schedule-episode"]) {
    expect(describeCommand(command).recovery).toContain("schedule-list");
    expect(describeCommand(command).recovery).toContain("Do not blindly create another schedule");
  }
  expect(describeCommand("schedule-cancel").recovery).toContain("schedule-status");
  expect(describeCommand("stats-retention").recovery).toContain("same Show and retention value");
  for (const command of ["skill", "backup-create", "backup-restore"]) {
    expect(describeCommand(command).recovery).toContain("Offline only");
    expect(describeCommand(command).recovery).not.toContain("Read-only observation");
  }
  expect(describeCommand("verify").recovery).toContain("Read-only observation");
  for (const command of ["publish-show", "publish-episode", "lifecycle-execute", "revision-execute"]) {
    expect(describeCommand(command).recovery).toContain("unchanged");
    expect(describeCommand(command).recovery).toContain("new review");
  }
});
