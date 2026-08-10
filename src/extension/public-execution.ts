export interface PublicSubagentExecutionParams {
	action?: unknown;
	agent?: unknown;
	task?: unknown;
	step?: unknown;
	tasks?: unknown;
	chain?: unknown;
	parallel?: unknown;
	concurrency?: unknown;
	chainDir?: unknown;
	workflowScript?: unknown;
	resume?: unknown;
	clarify?: unknown;
}

export type PublicSubagentExecutionMode = "workflow" | "management";

export type PublicSubagentExecutionNormalization<T> =
	| { ok: true; params: T }
	| { ok: false; error: string; mode: PublicSubagentExecutionMode };

/**
 * Keep public execution and management disjoint before requests reach the executor.
 * This fork retains direct single and bounded top-level tasks/chain compatibility;
 * internal runs.run children and structured owned delegation bypass this boundary.
 */
export function normalizePublicSubagentExecution<T extends PublicSubagentExecutionParams>(params: T): PublicSubagentExecutionNormalization<T> {
	const action = params.action;
	if (action !== undefined && (typeof action !== "string" || !action.trim())) {
		return { ok: false, error: "action must be a non-empty management/control action, or omitted for execution.", mode: "management" };
	}
	const normalizedAction = typeof action === "string" ? action.trim() : undefined;
	const hasTasks = params.tasks !== undefined;
	const hasChain = params.chain !== undefined;
	const hasTopLevelTasks = hasTasks || hasChain;
	const hasTopLevelControls = params.concurrency !== undefined || params.chainDir !== undefined;
	const hasRemovedAliases = params.parallel !== undefined;
	const hasDirectAgent = params.agent !== undefined;
	const hasTask = params.task !== undefined;
	const hasDirectExecutionField = hasDirectAgent || hasTask;

	if (params.resume !== undefined) {
		return { ok: false, error: "Top-level resume execution is not available. Put resume on a workflowScript runs.run/runs.all item.", mode: "workflow" };
	}
	if (normalizedAction !== undefined) {
		const legacyAction = normalizedAction.toLowerCase();
		if (legacyAction === "single") {
			return { ok: false, error: "action=single is not a management action; omit action and pass agent plus task directly.", mode: "workflow" };
		}
		if (legacyAction === "parallel" || legacyAction === "tasks" || legacyAction === "chain") {
			return { ok: false, error: "Execution modes must omit action; pass tasks/chain directly or use workflowScript.", mode: "workflow" };
		}
		if (normalizedAction === "schedule.create") {
			if (hasDirectExecutionField || hasTopLevelTasks || hasTopLevelControls || hasRemovedAliases || params.step !== undefined || params.clarify !== undefined) {
				return { ok: false, error: "schedule.create requires workflowScript and does not accept direct execution fields.", mode: "management" };
			}
			if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) {
				return { ok: false, error: "schedule.create requires a non-empty workflowScript.", mode: "management" };
			}
			return { ok: true, params: { ...params, action: normalizedAction } };
		}
		if (params.workflowScript !== undefined || hasTask || hasTopLevelTasks || hasTopLevelControls || hasRemovedAliases || params.clarify !== undefined) {
			return { ok: false, error: "Execution fields must omit action; only schedule.create accepts action with workflowScript.", mode: "management" };
		}
		return { ok: true, params: { ...params, action: normalizedAction } };
	}

	if (params.workflowScript !== undefined) {
		if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) {
			return { ok: false, error: "workflowScript must be non-empty.", mode: "workflow" };
		}
		if (hasDirectExecutionField || hasTopLevelTasks || hasTopLevelControls || hasRemovedAliases || params.step !== undefined) {
			return { ok: false, error: "workflowScript cannot be combined with direct agent, tasks, chain, concurrency, chainDir, parallel, or step fields.", mode: "workflow" };
		}
		if (params.clarify === true) {
			return { ok: false, error: "Public workflowScript execution does not support clarify UI.", mode: "workflow" };
		}
		return { ok: true, params };
	}
	if (hasRemovedAliases) {
		return { ok: false, error: "Top-level parallel is not supported; use tasks or workflowScript.", mode: "workflow" };
	}
	if (params.step !== undefined) {
		return { ok: false, error: "step is control-only and requires an appropriate action.", mode: "management" };
	}
	if ((hasDirectAgent && hasTopLevelTasks) || (hasTasks && hasChain) || (hasTask && hasTasks)) {
		return { ok: false, error: "Choose exactly one execution mode: direct agent, tasks, chain, or workflowScript.", mode: "workflow" };
	}
	if (hasTopLevelControls && !hasTopLevelTasks) {
		return { ok: false, error: "concurrency and chainDir require tasks or chain execution.", mode: "workflow" };
	}
	if (hasDirectAgent || hasTopLevelTasks) return { ok: true, params };
	return { ok: false, error: "Execution requires an agent, tasks, chain, or a non-empty workflowScript; task alone has no target.", mode: "workflow" };
}
