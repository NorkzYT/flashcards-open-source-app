import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpError } from "../../../shared/errors";
import { USER_OPENAI_API_KEY_HEADER } from "../../../shared/userOpenAIApiKeyNames";
import { createChatRoutes } from "../../../routes/chat";
import {
  aiUsageAllowanceTestOptions,
  createRequestContext,
  createRoutesWithHttpErrorJson,
  SESSION_ONE,
} from "./testSupport";

/**
 * Route boundary of NIBOMO_STANDALONE_AI_FUNDING=user-key: the route is built from the real dependency
 * factory (real keyring read from a synthetic key file), and only the run transaction is replaced by a
 * probe, so "refused before anything is written" means "prepareChatRun was never reached".
 */

// Synthetic only: never a real provider key.
const syntheticKey = `sk-synthetic-${randomUUID()}`;
const ENV_NAMES = [
  "NIBOMO_DEPLOYMENT", "NIBOMO_STANDALONE_AI_FUNDING", "NIBOMO_CHAT_CREDENTIAL_KEY_FILE", "NIBOMO_INSTANCE_ID", "OPENAI_API_KEY",
] as const;

function withEnv<Result>(values: Partial<Record<(typeof ENV_NAMES)[number], string>>, callback: () => Promise<Result>): Promise<Result> {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return callback().finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

type PrepareProbe = { calls: number; sealerPresent: boolean | null };

function buildApp(probe: PrepareProbe) {
  const routes = createChatRoutes({
    ...aiUsageAllowanceTestOptions,
    allowedOrigins: [],
    loadRequestContextFromRequestFn: async () => ({ requestAuthInputs: {} as never, requestContext: createRequestContext() }),
    resolveAccessibleChatWorkspaceIdFn: async () => "workspace-1",
    prepareChatRunFn: async (...args: ReadonlyArray<unknown>) => {
      probe.calls += 1;
      probe.sealerPresent = typeof args[args.length - 1] === "function";
      // Stop here: everything after the run transaction is outside this boundary.
      throw new HttpError(418, "probe reached prepareChatRun", "PROBE_REACHED_PREPARE");
    },
  });
  const app = createRoutesWithHttpErrorJson();
  app.route("/", routes);
  return app;
}

function postTurn(app: ReturnType<typeof buildApp>, withKey: boolean) {
  return app.request("http://localhost/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withKey ? { [USER_OPENAI_API_KEY_HEADER]: syntheticKey } : {}),
    },
    body: JSON.stringify({
      sessionId: SESSION_ONE,
      clientRequestId: `client-request-${randomUUID()}`,
      content: [{ type: "text", text: "Make one card about diffusion." }],
      timezone: "UTC",
    }),
  });
}

test("standalone user-key funding: keyless turn refused before prepare, keyed turn admitted and sealed; misconfiguration refused at construction", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "nibomo-user-key-route-"));
  try {
    const keyFile = join(directory, "chat_credential_key");
    writeFileSync(keyFile, randomBytes(48), { mode: 0o600 });
    const userKeyEnv = {
      NIBOMO_DEPLOYMENT: "standalone",
      NIBOMO_STANDALONE_AI_FUNDING: "user-key",
      NIBOMO_CHAT_CREDENTIAL_KEY_FILE: keyFile,
      NIBOMO_INSTANCE_ID: "route-test-instance",
    } as const;

    await withEnv(userKeyEnv, async () => {
      const probe: PrepareProbe = { calls: 0, sealerPresent: null };
      const app = buildApp(probe);

      const keyless = await postTurn(app, false);
      assert.equal(keyless.status, 400);
      const keylessBody = await keyless.json() as { code: string };
      assert.equal(keylessBody.code, "OPENAI_API_KEY_REQUIRED_STANDALONE");
      assert.equal(probe.calls, 0, "a keyless turn never reaches the run transaction");

      const keyed = await postTurn(app, true);
      assert.equal(keyed.status, 418, "a personal-key turn passes admission and reaches the run transaction");
      assert.equal(probe.calls, 1);
      assert.equal(probe.sealerPresent, true, "the key reaches the transaction only as a sealer");
      assert.equal(JSON.stringify(await keyed.json()).includes(syntheticKey), false);
    });

    // Without sealing, or beside an operator key, user-key funding stops route construction (API startup).
    await withEnv({ ...userKeyEnv, NIBOMO_CHAT_CREDENTIAL_KEY_FILE: undefined }, async () => {
      assert.throws(() => buildApp({ calls: 0, sealerPresent: null }), /user-key needs NIBOMO_CHAT_CREDENTIAL_KEY_FILE/);
    });
    await withEnv({ ...userKeyEnv, OPENAI_API_KEY: "sk-synthetic-operator" }, async () => {
      assert.throws(() => buildApp({ calls: 0, sealerPresent: null }), /must not be combined with OPENAI_API_KEY/);
    });
    await withEnv({ ...userKeyEnv, NIBOMO_STANDALONE_AI_FUNDING: "user_key" }, async () => {
      assert.throws(() => buildApp({ calls: 0, sealerPresent: null }), /must be "operator" or "user-key"/);
    });

    // Operator funding is unchanged: keyless without an operator key is still 503 before prepare,
    // with one it reaches the transaction without a sealer.
    await withEnv({ NIBOMO_DEPLOYMENT: "standalone" }, async () => {
      const probe: PrepareProbe = { calls: 0, sealerPresent: null };
      const response = await postTurn(buildApp(probe), false);
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { code: string }).code, "AI_PROVIDER_NOT_CONFIGURED");
      assert.equal(probe.calls, 0);
    });
    await withEnv({ NIBOMO_DEPLOYMENT: "standalone", OPENAI_API_KEY: "sk-synthetic-operator" }, async () => {
      const probe: PrepareProbe = { calls: 0, sealerPresent: null };
      assert.equal((await postTurn(buildApp(probe), false)).status, 418);
      assert.equal(probe.calls, 1);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
