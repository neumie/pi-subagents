import * as fs from "node:fs";
import {
	listCachedAsyncRuns,
	type AsyncRunSummary,
} from "../runs/background/async-status.ts";
import { truncateUtf8WithMarker } from "../runs/background/async-task-preview.ts";

const MAX_RECENT_RUNS = 20;
const MAX_WATCH_METADATA_BYTES = 2_048;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 2_000;
type WatchStep = AsyncRunSummary["steps"][number];

export interface SubagentWatchTarget {
	key: string;
	runId: string;
	asyncDir: string;
	runState: AsyncRunSummary["state"];
	mode: AsyncRunSummary["mode"];
	startedAt: number;
	endedAt?: number;
	index: number;
	agent: string;
	label?: string;
	phase?: string;
	sessionFile?: string;
	/** Bounded caller-facing task preview. Older status files may not contain this. */
	task?: string;
	status: WatchStep["status"] | AsyncRunSummary["state"];
	durationMs?: number;
	model?: string;
	thinking?: string;
	activityState?: WatchStep["activityState"];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: NonNullable<WatchStep["recentTools"]>;
	turnCount?: number;
	toolCount?: number;
	tokens?: WatchStep["tokens"];
	recentOutput?: string[];
	error?: string;
}

export interface SubagentWatchOptions {
	asyncDirRoot: string;
	sessionId: string;
	maxRecentRuns?: number;
}

export interface SubagentOutputTailSnapshot {
	lines: string[];
	omittedBytes: boolean;
	omittedLines: boolean;
	error?: string;
}

function targetFromStep(
	run: AsyncRunSummary,
	step: WatchStep,
): SubagentWatchTarget {
	return {
		key: `${run.id}:${step.index}`,
		runId: run.id,
		asyncDir: run.asyncDir,
		runState: run.state,
		mode: run.mode,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		index: step.index,
		agent: step.agent,
		label: step.label,
		phase: step.phase,
		sessionFile: step.sessionFile,
		task: step.task,
		status: step.status,
		durationMs: step.durationMs,
		model: step.model,
		thinking: step.thinking,
		activityState: step.activityState,
		lastActivityAt: step.lastActivityAt,
		currentTool: step.currentTool,
		currentToolArgs: step.currentToolArgs,
		currentToolStartedAt: step.currentToolStartedAt,
		currentPath: step.currentPath,
		recentTools: step.recentTools,
		turnCount: step.turnCount,
		toolCount: step.toolCount,
		tokens: step.tokens,
		recentOutput: step.recentOutput,
		error: step.error,
	};
}

function fallbackTarget(run: AsyncRunSummary): SubagentWatchTarget {
	// Status artifacts are untrusted runtime input. Only a non-negative safe
	// integer can name an output-N.log file.
	const currentStep = run.currentStep;
	const index =
		typeof currentStep === "number" &&
		Number.isSafeInteger(currentStep) &&
		currentStep >= 0
			? currentStep
			: 0;
	return {
		key: `${run.id}:${index}`,
		runId: run.id,
		asyncDir: run.asyncDir,
		runState: run.state,
		mode: run.mode,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		index,
		agent: "subagent",
		status: run.state,
		activityState: run.activityState,
		lastActivityAt: run.lastActivityAt,
		currentTool: run.currentTool,
		currentToolStartedAt: run.currentToolStartedAt,
		currentPath: run.currentPath,
		turnCount: run.turnCount,
		toolCount: run.toolCount,
		tokens: run.totalTokens,
		error: run.error,
	};
}

export function buildSubagentWatchTargets(
	runs: AsyncRunSummary[],
): SubagentWatchTarget[] {
	return runs.flatMap((run) =>
		run.steps.length > 0
			? run.steps.map((step) => targetFromStep(run, step))
			: [fallbackTarget(run)],
	);
}

/** Read-only discovery: scan once and reuse summaries whose status file is unchanged. */
export function discoverSubagentWatchTargets(
	options: SubagentWatchOptions,
): SubagentWatchTarget[] {
	const runs = listCachedAsyncRuns(options.asyncDirRoot, {
		sessionId: options.sessionId,
	});
	const active: AsyncRunSummary[] = [];
	const recent: AsyncRunSummary[] = [];
	for (const run of runs) {
		if (
			run.state === "queued" ||
			run.state === "running" ||
			run.state === "paused"
		)
			active.push(run);
		else recent.push(run);
	}
	return buildSubagentWatchTargets([
		...active,
		...recent.slice(0, options.maxRecentRuns ?? MAX_RECENT_RUNS),
	]);
}

/**
 * Bound untrusted display metadata before sanitization or wrapping. The marker
 * makes omission explicit. The shared UTF-8 truncator keeps the marker inside
 * the declared byte cap.
 */
export function boundSubagentMetadata(
	value: string,
	maxBytes = MAX_WATCH_METADATA_BYTES,
): string {
	return truncateUtf8WithMarker(value, maxBytes);
}

export function sanitizeSubagentText(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009d[^\u009c]*(?:\u009c|$)/g, "")
		.replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * Return a bounded, sanitized tail while preserving whether its beginning is
 * incomplete. Errors are metadata so callers can retain a prior good view.
 */
export function readSubagentOutputTailSnapshot(
	filePath: string,
): SubagentOutputTailSnapshot {
	let descriptor: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size === 0)
			return { lines: [], omittedBytes: false, omittedLines: false };
		const start = Math.max(0, stat.size - MAX_LOG_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.alloc(length);
		descriptor = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
		let lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
		const omittedBytes = start > 0;
		// A byte tail normally starts in a partial line. Discard it only when a
		// delimiter exists; an oversized single line still deserves a bounded tail.
		if (start > 0 && lines.length > 1) lines.shift();
		if (lines.at(-1) === "") lines.pop();
		const omittedLines = lines.length > MAX_LOG_LINES;
		if (omittedLines) lines = lines.slice(-MAX_LOG_LINES);
		return {
			lines: lines.map(sanitizeSubagentText),
			omittedBytes,
			omittedLines,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { lines: [], omittedBytes: false, omittedLines: false };
		return {
			lines: [],
			omittedBytes: false,
			omittedLines: false,
			error: sanitizeSubagentText(
				error instanceof Error ? error.message : String(error),
			),
		};
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The live log can disappear between read and close.
			}
		}
	}
}

/** Compatibility wrapper for existing array-only consumers. */
export function readSubagentOutputTail(filePath: string): string[] {
	return readSubagentOutputTailSnapshot(filePath).lines;
}
