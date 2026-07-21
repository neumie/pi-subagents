import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps, formatAsyncStartedMessage, resolveAsyncRunnerLogPaths } from "../../src/runs/background/async-execution.ts";
import {
	ASYNC_TASK_PREVIEW_MAX_BYTES,
	toAsyncTaskPreview,
} from "../../src/runs/background/async-task-preview.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const agent = (name: string, toolBudget?: AgentConfig["toolBudget"]): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...(toolBudget ? { toolBudget } : {}),
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

describe("async runner execution", () => {
	it("formats interactive yield and headless auto-drain guidance separately", () => {
		const interactive = formatAsyncStartedMessage("Async: worker [interactive]", true);
		assert.match(interactive, /interactive session[\s\S]*return control/i);
		assert.match(interactive, /do not call subagent_wait\(\) merely to wait/i);
		assert.doesNotMatch(interactive, /auto-drains current-session background work/i);

		const headless = formatAsyncStartedMessage("Async: worker [headless]", false);
		assert.match(headless, /non-interactive run.*auto-drains current-session background work at agent_end/i);
		assert.match(headless, /call subagent_wait\(\).*results before it ends/i);
		assert.doesNotMatch(headless, /By default, return control to the user/i);
	});

	it("places detached runner stdio logs in the async run directory", () => {
		const asyncDir = path.join("tmp", "async-run");
		assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
			stdoutPath: path.join(asyncDir, "runner.stdout.log"),
			stderrPath: path.join(asyncDir, "runner.stderr.log"),
		});
	});

	it("omits runner log paths when asyncDir is unavailable", () => {
		assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
	});

	it("resolves async step tool budgets with step over run over agent over config precedence", () => {
		const result = buildAsyncRunnerSteps("run-1", {
			chain: [
				{ agent: "worker", task: "agent beats config" },
				{ agent: "worker", task: "step beats run", toolBudget: { hard: 2, block: ["grep"] } },
			],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
			toolBudget: { hard: 3, block: ["find"] },
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 3, block: ["find"] });
		assert.equal(result.steps[0]?.waitToolEnabled, false);
		assert.deepEqual(result.steps[1]?.toolBudget, { hard: 2, block: ["grep"] });
	});

	it("uses agent tool budget before config default when no run override exists", () => {
		const result = buildAsyncRunnerSteps("run-2", {
			chain: [{ agent: "worker", task: "agent beats config" }],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 4, block: ["read"] });
	});

	it("keeps raw caller metadata separate from fork execution prompts", () => {
		const result = buildAsyncRunnerSteps("run-raw", {
			chain: [{ agent: "worker", task: "fork preamble\n\nTask:\nRaw task" }],
			callerChain: [{ agent: "worker", task: "Raw task" }],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
		});
		assert.ok("steps" in result, "expected successful step build");
		const step = result.steps[0];
		assert.equal("parallel" in step, false);
		assert.equal("callerTask" in step && step.callerTask, "Raw task");
		assert.match("task" in step ? step.task : "", /fork preamble/);
	});

	it("uses {previous} when caller-chain tasks are omitted", () => {
		const result = buildAsyncRunnerSteps("run-omitted", {
			chain: [
				{ agent: "worker", task: "wrapped sequential" },
				{ parallel: [{ agent: "worker", task: "wrapped parallel" }] },
				{
					expand: { from: { output: "items", path: "/" }, item: "item" },
					parallel: { agent: "worker", task: "wrapped dynamic" },
					collect: { as: "results" },
				},
			],
			callerChain: [
				{ agent: "worker" },
				{ parallel: [{ agent: "worker" }] },
				{
					expand: { from: { output: "items", path: "/" }, item: "item" },
					parallel: { agent: "worker" },
					collect: { as: "results" },
				},
			],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			validateOutputBindings: false,
		});
		assert.ok("steps" in result);
		const [sequential, parallel, dynamic] = result.steps;
		assert.equal(
			"callerTask" in sequential && sequential.callerTask,
			"{previous}",
		);
		assert.equal(
			"parallel" in parallel &&
				Array.isArray(parallel.parallel) &&
				parallel.parallel[0]?.callerTask,
			"{previous}",
		);
		assert.equal(
			"parallel" in dynamic &&
				!Array.isArray(dynamic.parallel) &&
				dynamic.parallel.callerTask,
			"{previous}",
		);
	});

	it("bounds task previews on UTF-8 code-point boundaries", () => {
		const preview = toAsyncTaskPreview(
			"é".repeat(ASYNC_TASK_PREVIEW_MAX_BYTES),
		);
		assert.ok(preview?.endsWith("… [truncated]"));
		assert.ok(
			Buffer.byteLength(preview ?? "", "utf8") <= ASYNC_TASK_PREVIEW_MAX_BYTES,
		);
		assert.equal(
			toAsyncTaskPreview("x".repeat(ASYNC_TASK_PREVIEW_MAX_BYTES)),
			"x".repeat(ASYNC_TASK_PREVIEW_MAX_BYTES),
		);
		assert.equal(toAsyncTaskPreview(undefined), undefined);
	});

	it("uses config default when no step, run, or agent budget exists", () => {
		const result = buildAsyncRunnerSteps("run-3", {
			chain: [{ agent: "worker", task: "config default" }],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 5, block: ["ls"] });
	});
});
