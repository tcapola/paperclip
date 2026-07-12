import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { execute, resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function runExecuteWithFakeHermes(
  config: Record<string, unknown>,
  authToken = "run-auth-token",
): Promise<Record<string, string | undefined>> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-env-normalization-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const envPath = path.join(tempDir, "env.txt");

  try {
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        "printf 'HERMES_HOME=%s\\n' \"$HERMES_HOME\" > \"$HERMES_ENV_FILE\"",
        "printf 'PAPERCLIP_API_KEY=%s\\n' \"$PAPERCLIP_API_KEY\" >> \"$HERMES_ENV_FILE\"",
        "printf 'IGNORED_VALUE=%s\\n' \"$IGNORED_VALUE\" >> \"$HERMES_ENV_FILE\"",
        "printf 'ok\\n\\nsession_id: session-test\\n'",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    await execute({
      runId: "run-test",
      agent: {
        id: "agent-test",
        name: "Hermes Test Agent",
        companyId: "company-test",
        adapterConfig: {},
      },
      config: {
        ...config,
        hermesCommand: cliPath,
        cwd: tempDir,
        env: {
          ...(config.env && typeof config.env === "object" && !Array.isArray(config.env)
            ? config.env
            : {}),
          HERMES_ENV_FILE: envPath,
        },
      },
      runtime: {},
      onLog: async () => {},
      authToken,
    } as any);

    return Object.fromEntries(
      (await readFile(envPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [key, ...valueParts] = line.split("=");
          return [key, valueParts.join("=")];
        }),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("execute normalizes wrapped env values before spawning Hermes", async () => {
  const env = await runExecuteWithFakeHermes({
    env: {
      HERMES_HOME: { type: "plain", value: "/tmp/hermes-home" },
      IGNORED_VALUE: { type: "plain" },
    },
  });

  expect(env.HERMES_HOME).toBe("/tmp/hermes-home");
  expect(env.IGNORED_VALUE).toBe("");
});

test("execute preserves explicit PAPERCLIP_API_KEY over authToken", async () => {
  const env = await runExecuteWithFakeHermes({
    env: {
      PAPERCLIP_API_KEY: { type: "plain", value: "explicit-api-key" },
    },
  });

  expect(env.PAPERCLIP_API_KEY).toBe("explicit-api-key");
});

test("execute falls back to authToken when PAPERCLIP_API_KEY is absent", async () => {
  const env = await runExecuteWithFakeHermes({});

  expect(env.PAPERCLIP_API_KEY).toBe("run-auth-token");
});
