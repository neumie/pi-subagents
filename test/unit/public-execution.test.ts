import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";

describe("public subagent execution normalization", () => {
	it("accepts direct, compatibility, workflow, management, and scheduled execution", () => {
		for (const params of [
			{ agent: "worker", task: "work" },
			{ agent: "worker", task: "work", clarify: true },
			{ tasks: [{ agent: "worker", task: "work" }], concurrency: 1 },
			{ task: "root request", chain: [{ agent: "worker", task: "work" }], chainDir: "/tmp/chain" },
			{ workflowScript: "return 1" },
			{ workflowScript: "return 1", clarify: false },
		] as const) {
			assert.deepEqual(normalizePublicSubagentExecution(params), { ok: true, params });
		}
		assert.deepEqual(normalizePublicSubagentExecution({ action: " list " }), { ok: true, params: { action: "list" } });
		assert.deepEqual(normalizePublicSubagentExecution({ action: "get", agent: "worker" }), { ok: true, params: { action: "get", agent: "worker" } });
		assert.deepEqual(
			normalizePublicSubagentExecution({ action: " schedule.create ", every: "1h", workflowScript: "return 1" }),
			{ ok: true, params: { action: "schedule.create", every: "1h", workflowScript: "return 1" } },
		);
	});

	it("rejects ambiguous or unsupported public execution shapes", () => {
		for (const params of [
			{ action: " " },
			{ action: "single" },
			{ action: "parallel" },
			{ action: "chain" },
			{ parallel: [{ agent: "worker" }] },
			{ concurrency: 2 },
			{ agent: "worker", concurrency: 2 },
			{ workflowScript: "return 1", concurrency: 2 },
			{ action: "list", concurrency: 2 },
			{ clarify: true, workflowScript: "return 1" },
			{ resume: "retained-run", workflowScript: "return 1" },
			{},
			{ workflowScript: " " },
			{ workflowScript: "return 1", agent: "worker", task: "work" },
			{ agent: "worker", tasks: [{ agent: "reviewer" }] },
			{ task: "root request", tasks: [{ agent: "worker" }] },
			{ tasks: [{ agent: "worker" }], chain: [{ agent: "reviewer" }] },
			{ task: "orphan task" },
			{ action: "status", workflowScript: "return 1" },
			{ action: "list", task: "work" },
			{ action: "list", clarify: true },
			{ action: "schedule.create", every: "1h", workflowScript: "return 1", clarify: false },
			{ action: "schedule.create", every: "1h", agent: "worker", workflowScript: "return 1" },
		] as const) {
			assert.equal(normalizePublicSubagentExecution(params).ok, false, JSON.stringify(params));
		}
	});
});
