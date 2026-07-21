import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";
import {
	buildSubagentWatchTargets,
	discoverSubagentWatchTargets,
	readSubagentOutputTail,
	readSubagentOutputTailSnapshot,
	boundSubagentMetadata,
	type SubagentWatchTarget,
} from "../../src/tui/subagent-watch-data.ts";
import { SubagentWatchView } from "../../src/tui/subagent-watch.ts";

function run(overrides: Partial<AsyncRunSummary> = {}): AsyncRunSummary {
	return {
		id: "run-1",
		asyncDir: "/tmp/run-1",
		state: "running",
		mode: "parallel",
		startedAt: 1_000,
		steps: [
			{ index: 0, agent: "reviewer", status: "running", currentTool: "read" },
			{ index: 1, agent: "scout", status: "complete", currentTool: "grep" },
		],
		...overrides,
	};
}

function target(
	asyncDir: string,
	index: number,
	agent: string,
): SubagentWatchTarget {
	return {
		key: `run-1:${index}`,
		runId: "run-1",
		asyncDir,
		runState: "running",
		mode: "parallel",
		startedAt: Date.now() - 1_000,
		index,
		agent,
		status: "running",
		currentTool: index === 0 ? "read" : "bash",
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as ExtensionContext["ui"]["theme"];

function fakeTui(rows = 30): TUI {
	return {
		terminal: { rows },
		requestRender() {},
	} as unknown as TUI;
}

describe("subagent watch", () => {
	it("flattens parallel run steps into switchable child targets", () => {
		const targets = buildSubagentWatchTargets([run()]);
		assert.deepEqual(
			targets.map((item) => ({
				key: item.key,
				agent: item.agent,
				tool: item.currentTool,
			})),
			[
				{ key: "run-1:0", agent: "reviewer", tool: "read" },
				{ key: "run-1:1", agent: "scout", tool: "grep" },
			],
		);
	});

	it("preserves live and recent activity metadata for the selected child", () => {
		const targets = buildSubagentWatchTargets([
			run({
				steps: [
					{
						index: 0,
						agent: "reviewer",
						status: "running",
						activityState: "active_long_running",
						lastActivityAt: 9_500,
						currentTool: "read",
						currentToolArgs: "src/current.ts",
						currentToolStartedAt: 9_000,
						currentPath: "src/current.ts",
						recentTools: [{ tool: "grep", args: "src", endMs: 8_000 }],
					},
				],
			}),
		]);
		assert.deepEqual(
			{
				activityState: targets[0]?.activityState,
				lastActivityAt: targets[0]?.lastActivityAt,
				currentToolStartedAt: targets[0]?.currentToolStartedAt,
				recentTools: targets[0]?.recentTools,
			},
			{
				activityState: "active_long_running",
				lastActivityAt: 9_500,
				currentToolStartedAt: 9_000,
				recentTools: [{ tool: "grep", args: "src", endMs: 8_000 }],
			},
		);
	});

	it("creates a fallback target before a run has materialized steps", () => {
		const targets = buildSubagentWatchTargets([
			run({ mode: "single", steps: [], currentStep: 2, currentTool: "bash" }),
		]);
		assert.equal(targets.length, 1);
		assert.equal(targets[0]?.key, "run-1:2");
		assert.equal(targets[0]?.index, 2);
		assert.equal(targets[0]?.currentTool, "bash");
	});

	it("tails output and strips terminal control sequences", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-watch-"));
		const output = path.join(root, "output-0.log");
		try {
			fs.writeFileSync(
				output,
				"\u001b[31mred\u001b[0m\nnormal\u0007\nsafe\u009b31mRED\u009b0m\rOVER\n",
				"utf8",
			);
			assert.deepEqual(readSubagentOutputTail(output), [
				"red",
				"normal",
				"safeREDOVER",
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps caller-facing task metadata with older status files still readable", () => {
		const targets = buildSubagentWatchTargets([
			run({
				steps: [
					{
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "Review {task}",
					},
				],
			}),
		]);
		assert.equal(targets[0]?.task, "Review {task}");
		assert.equal(
			buildSubagentWatchTargets([
				run({ steps: [{ index: 0, agent: "reviewer", status: "running" }] }),
			])[0]?.task,
			undefined,
		);
	});

	it("reports tail omissions and retains an oversized single line", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagent-watch-tail-"),
		);
		const output = path.join(root, "output-0.log");
		try {
			fs.writeFileSync(
				output,
				`\u001b[31m${"x".repeat(300_000)}\u001b[0m`,
				"utf8",
			);
			const snapshot = readSubagentOutputTailSnapshot(output);
			assert.equal(snapshot.omittedBytes, true);
			assert.ok(snapshot.lines[0]?.length);
			assert.equal(snapshot.lines[0]?.includes("\u001b"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps every active run while limiting recent runs and filtering other sessions", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagent-watch-discovery-"),
		);
		const writeStatus = (
			id: string,
			sessionId: string,
			state: "running" | "complete",
			startedAt: number,
		) => {
			const dir = path.join(root, id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "status.json"),
				JSON.stringify({
					runId: id,
					sessionId,
					mode: "single",
					state,
					startedAt,
					lastUpdate: startedAt,
					steps: [
						{
							agent: id,
							status: state === "running" ? "running" : "complete",
							startedAt,
						},
					],
				}),
				"utf8",
			);
		};
		try {
			for (let index = 0; index < 21; index++)
				writeStatus(`active-${index}`, "session-test", "running", index + 1);
			writeStatus("recent-old", "session-test", "complete", 100);
			writeStatus("recent-new", "session-test", "complete", 200);
			writeStatus("other-session", "session-other", "running", 300);
			const targets = discoverSubagentWatchTargets({
				asyncDirRoot: root,
				sessionId: "session-test",
				maxRecentRuns: 1,
			});
			assert.equal(
				targets.filter((item) => item.runState === "running").length,
				21,
			);
			assert.deepEqual(
				targets
					.filter((item) => item.runState === "complete")
					.map((item) => item.runId),
				["recent-new"],
			);
			assert.equal(
				targets.some((item) => item.runId === "other-session"),
				false,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scrolls wrapped visual lines rather than raw log lines", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagent-watch-scroll-"),
		);
		try {
			fs.writeFileSync(
				path.join(root, "output-0.log"),
				`${"x".repeat(2_400)}\n`,
				"utf8",
			);
			const view = new SubagentWatchView(
				fakeTui(30),
				theme,
				{ asyncDirRoot: root, sessionId: "session-test" },
				() => {},
				[target(root, 0, "reviewer")],
			);
			try {
				view.handleInput("\r");
				view.render(120);
				view.handleInput("\u001b[5~");
				assert.match(view.render(120).join("\n"), /PAUSED/);
			} finally {
				view.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects, watches, switches children, and returns to the parent", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagent-watch-view-"),
		);
		try {
			fs.writeFileSync(
				path.join(root, "output-0.log"),
				"read: src/auth.ts\n",
				"utf8",
			);
			fs.writeFileSync(
				path.join(root, "output-1.log"),
				"bash: npm test\n",
				"utf8",
			);
			let closed = false;
			const view = new SubagentWatchView(
				fakeTui(),
				theme,
				{ asyncDirRoot: root, sessionId: "session-test" },
				() => {
					closed = true;
				},
				[target(root, 0, "reviewer"), target(root, 1, "scout")],
			);
			try {
				assert.match(view.render(80).join("\n"), /Subagents/);
				view.handleInput("\r");
				assert.match(view.render(80).join("\n"), /read: src\/auth\.ts/);
				view.handleInput("\t");
				assert.match(view.render(80).join("\n"), /scout/);
				assert.match(view.render(80).join("\n"), /bash: npm test/);
				view.handleInput("\u001b");
				assert.equal(closed, true);
			} finally {
				view.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries a transient transcript read failure with an unchanged file signature", () => {
		let tick: (() => void) | undefined;
		let reads = 0;
		const watched = { ...target("/virtual", 0, "reviewer"), startedAt: 0 };
		const view = new SubagentWatchView(
			fakeTui(),
			theme,
			{ asyncDirRoot: "/virtual", sessionId: "session-test" },
			() => {},
			[watched],
			{
				now: () => 0,
				stat: () => ({ size: 4, mtimeMs: 1 }),
				readOutput: () =>
					++reads === 1
						? {
								lines: [],
								omittedBytes: false,
								omittedLines: false,
								error: "temporarily busy",
							}
						: {
								lines: ["recovered output"],
								omittedBytes: false,
								omittedLines: false,
							},
				setInterval: (callback) => {
					tick = callback;
					return 0 as unknown as ReturnType<typeof setInterval>;
				},
				clearInterval: () => {},
			},
		);
		try {
			view.handleInput("\r");
			assert.match(view.render(80).join("\n"), /Transcript read failed/);
			tick?.();
			assert.equal(reads, 2);
			assert.match(view.render(80).join("\n"), /recovered output/);
		} finally {
			view.dispose();
		}
	});

	it("repaints active elapsed time when a terminal sibling is selected", () => {
		let now = 0;
		let tick: (() => void) | undefined;
		let renders = 0;
		const running = { ...target("/virtual", 0, "worker"), startedAt: 0 };
		const complete = {
			...target("/virtual", 1, "reviewer"),
			status: "complete" as const,
			durationMs: 500,
		};
		const view = new SubagentWatchView(
			{
				terminal: { rows: 30 },
				requestRender: () => {
					renders++;
				},
			} as unknown as TUI,
			theme,
			{ asyncDirRoot: "/virtual", sessionId: "session-test" },
			() => {},
			undefined,
			{
				now: () => now,
				discover: () => [running, complete],
				stat: () => undefined,
				readOutput: () => ({
					lines: [],
					omittedBytes: false,
					omittedLines: false,
				}),
				setInterval: (callback) => {
					tick = callback;
					return 0 as unknown as ReturnType<typeof setInterval>;
				},
				clearInterval: () => {},
			},
		);
		try {
			view.handleInput("\u001b[B");
			view.render(80);
			renders = 0;
			now = 1_000;
			tick?.();
			assert.ok(renders > 0);
		} finally {
			view.dispose();
		}
	});

	it("bounds metadata before display processing on UTF-8 boundaries", () => {
		const cap = 32;
		const bounded = boundSubagentMetadata("😀".repeat(2_000), cap);
		assert.match(bounded, /\[truncated\]$/);
		assert.ok(Buffer.byteLength(bounded, "utf8") <= cap);
	});

	it("routes Home and End through immediate transcript selection", () => {
		let clears = 0;
		const view = new SubagentWatchView(
			fakeTui(),
			theme,
			{ asyncDirRoot: "/virtual", sessionId: "s" },
			() => {},
			[target("/virtual", 0, "first"), target("/virtual", 1, "last")],
			{
				stat: () => ({ size: 1, mtimeMs: 1 }),
				readOutput: (file) => ({
					lines: [
						file.endsWith("output-1.log") ? "last output" : "first output",
					],
					omittedBytes: false,
					omittedLines: false,
				}),
				setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
				clearInterval: () => {
					clears++;
				},
			},
		);
		view.handleInput("\u001b[F");
		view.handleInput("\r");
		assert.match(view.render(80).join("\n"), /last output/);
		view.dispose();
		view.dispose();
		assert.equal(clears, 1);
	});

	it("preserves output omission state after a transient read failure", () => {
		let reads = 0;
		const view = new SubagentWatchView(
			fakeTui(),
			theme,
			{ asyncDirRoot: "/virtual", sessionId: "s" },
			() => {},
			[target("/virtual", 0, "worker")],
			{
				stat: () => ({ size: ++reads, mtimeMs: reads }),
				readOutput: () =>
					reads === 1
						? { lines: ["partial"], omittedBytes: true, omittedLines: false }
						: {
								lines: [],
								omittedBytes: false,
								omittedLines: false,
								error: "busy",
							},
				setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
				clearInterval: () => {},
			},
		);
		try {
			view.handleInput("\r");
			assert.match(view.render(80).join("\n"), /Earlier output omitted/);
		} finally {
			view.dispose();
		}
	});

	it("discovers synchronously and repaints metadata-only and active elapsed updates", () => {
		let now = 0;
		let tick: (() => void) | undefined;
		let renders = 0;
		const watched = { ...target("/virtual", 0, "reviewer"), startedAt: 0 };
		let discovered = [watched];
		const tui = {
			terminal: { rows: 30 },
			requestRender: () => {
				renders++;
			},
		} as unknown as TUI;
		const view = new SubagentWatchView(
			tui,
			theme,
			{ asyncDirRoot: "/virtual", sessionId: "session-test" },
			() => {},
			undefined,
			{
				now: () => now,
				discover: () => discovered,
				stat: () => undefined,
				readOutput: () => ({
					lines: [],
					omittedBytes: false,
					omittedLines: false,
				}),
				setInterval: (callback) => {
					tick = callback;
					return 0 as unknown as ReturnType<typeof setInterval>;
				},
				clearInterval: () => {},
			},
		);
		try {
			assert.match(view.render(80).join("\n"), /reviewer/);
			view.handleInput("\r");
			discovered = [
				{ ...watched, model: "fresh-model", currentToolArgs: "--new" },
			];
			now = 1_000;
			tick?.();
			assert.match(view.render(80).join("\n"), /fresh-model/);
			const afterMetadata = renders;
			now = 2_000;
			tick?.();
			assert.ok(renders > afterMetadata);
		} finally {
			view.dispose();
		}
	});
});
