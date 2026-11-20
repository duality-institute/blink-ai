import type { AnswerClient, AnswerPrompts } from "../core/answer-client";
import { ensureProjectDir } from "../core/config";
import type { BlinkConfig } from "../core/types";
import { ClaudeClient } from "./claude-client";
import { CodexClient } from "./codex-client";
import { LocalAnswerClient } from "./local-answer-client";
import { resolvePrompts, type LocalEngine } from "./local-engine";
import { OpenCodeClient } from "./opencode-client";
import { resolveOpenCodeModel } from "./opencode-model";
import { OpenCodeProcess } from "./opencode-process";

export class LocalAnswerConfigError extends Error {
  override readonly name = "LocalAnswerConfigError";
}

type Backend = {
  readonly label: string;
  readonly engine: () => LocalEngine;
  readonly release?: () => Promise<void>;
};

export async function createLocalAnswerClient(
  config: BlinkConfig,
): Promise<AnswerClient> {
  const projectDir = await ensureProjectDir(config);
  const prompts = resolvePrompts({
    monitor: config.monitorPrompt,
    meeting: config.meetingPrompt,
  });
  const backend = await startBackend(config, projectDir, prompts);
  return new LocalAnswerClient({
    label: backend.label,
    engines: { monitor: backend.engine(), meeting: backend.engine() },
    prompts,
    ...(backend.release === undefined ? {} : { release: backend.release }),
  });
}

async function startBackend(
  config: BlinkConfig,
  projectDir: string,
  prompts: AnswerPrompts,
): Promise<Backend> {
  const model = config.model;
  switch (config.backend) {
    case "claude":
      return { label: "Claude", engine: () => new ClaudeClient({ prompts, projectDir, model }) };
    case "codex":
      return { label: "Codex", engine: () => new CodexClient({ prompts, projectDir, model }) };
    case "opencode": {
      const openCodeModel = parseOpenCodeModel(model ?? await resolveOpenCodeModel(undefined, projectDir));
      const server = new OpenCodeProcess({
        binary: "opencode",
        port: 0,
        workingDirectory: projectDir,
      });
      const endpoint = await server.start();
      return {
        label: "OpenCode",
        engine: () =>
          new OpenCodeClient({
            baseUrl: endpoint.url,
            password: endpoint.password,
            model: openCodeModel,
            projectDirectory: projectDir,
            prompts,
          }),
        release: () => server.stop(),
      };
    }
  }
}

function parseOpenCodeModel(
  model: string | undefined,
): { readonly providerID: string; readonly modelID: string } {
  const separator = model?.indexOf("/") ?? -1;
  if (model === undefined || separator <= 0 || separator === model.length - 1) {
    throw new LocalAnswerConfigError(
      "OpenCode needs a model as provider/model, e.g. anthropic/claude-sonnet-4-5",
    );
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}
