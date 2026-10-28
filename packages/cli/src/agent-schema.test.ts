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

test("help and describe share options; unknown outcomes never advertise retry", () => {
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
