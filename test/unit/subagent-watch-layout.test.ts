import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	overlayHeightBudget,
	renderSubagentWatchLayout,
} from "../../src/tui/subagent-watch-layout.ts";
import type { SubagentWatchTarget } from "../../src/tui/subagent-watch-data.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};
const target: SubagentWatchTarget = {
	key: "run:0",
	runId: "run",
	asyncDir: "/tmp/a;not-a-command",
	runState: "running",
	mode: "single",
	startedAt: 0,
	index: 0,
	agent: "reviewer",
	label: "監査",
	task: "Review\nthis \u001b[31mcaller task\u001b[0m carefully",
	status: "running",
	durationMs: 10,
};

describe("subagent watch layout", () => {
	it("keeps rounded complete frames bounded across narrow supported sizes", () => {
		for (const width of [12, 20, 40, 80, 100])
			for (const rows of [8, 12, 24]) {
				const height = overlayHeightBudget(rows);
				const result = renderSubagentWatchLayout({
					width,
					height,
					theme,
					mode: "select",
					help: false,
					loading: false,
					targets: [target],
					selected: 0,
					transcript: ["output"],
					transcriptState: "Transcript",
					follow: true,
					scrollTop: 0,
					duration: () => "10ms",
				});
				assert.equal(result.lines[0]?.startsWith("╭"), true);
				assert.equal(result.lines.at(-1)?.startsWith("╰"), true);
				assert.ok(result.lines.every((line) => visibleWidth(line) <= width));
				assert.ok(
					result.lines.every(
						(line) =>
							line.startsWith("╭") ||
							line.startsWith("╰") ||
							line.startsWith("│"),
					),
				);
			}
	});

	it("sanitizes and wraps task metadata while preserving a labeled detail section", () => {
		const result = renderSubagentWatchLayout({
			width: 40,
			height: 20,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [target],
			selected: 0,
			transcript: [],
			transcriptState: "Waiting for first output…",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		const text = result.lines.join("\n");
		assert.match(text, /Task:/);
		assert.match(text, /Review/);
		assert.equal(text.includes("\u001b[31m"), false);
	});

	it("makes current and recent activity prominent and safely readable", () => {
		const result = renderSubagentWatchLayout({
			width: 100,
			height: 24,
			now: 10_000,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [{
				...target,
				currentTool: "read",
				currentToolStartedAt: 8_000,
				currentPath: "src/live.ts",
				currentToolArgs: "\u001b[31msrc/live.ts\u001b[0m",
				lastActivityAt: 9_500,
				recentTools: [
					{ tool: "grep", args: "src/tui", endMs: 7_000 },
					{ tool: "read", args: "src/previous.ts", endMs: 8_000 },
				],
			}],
			selected: 0,
			transcript: [],
			transcriptState: "Waiting",
			follow: true,
			scrollTop: 0,
			duration: () => "10s",
		});
		const text = result.lines.join("\n");
		assert.match(text, /● NOW · READ · 2s elapsed/);
		assert.match(text, /src\/live\.ts/);
		assert.match(text, /Recent activity:/);
		assert.match(text, /grep · src\/tui · 3s ago/);
		assert.equal(text.includes("\u001b[31m"), false);
	});

	it("uses real wide columns and keeps the newest transcript rows visible", () => {
		const transcript = Array.from(
			{ length: 20 },
			(_, index) => `line-${index + 1}`,
		);
		const result = renderSubagentWatchLayout({
			width: 100,
			height: 21,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [target],
			selected: 0,
			transcript,
			transcriptState: "Transcript",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		const text = result.lines.join("\n");
		assert.equal(result.kind, "wide");
		assert.ok(result.lines.some((line) => line.includes(" │ ")));
		assert.equal(result.maxTop, transcript.length - result.bodyRows);
		assert.match(text, /line-20/);
		assert.doesNotMatch(text, /line-1\n/);
	});

	it("preserves transcript content across the full calculated wide pane", () => {
		const result = renderSubagentWatchLayout({
			width: 100,
			height: 21,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [target],
			selected: 0,
			transcript: [`${"x".repeat(59)}Q`],
			transcriptState: "Transcript",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		assert.equal(result.kind, "wide");
		assert.match(result.lines.join("\n"), /Q/);
		assert.ok(result.lines.every((line) => visibleWidth(line) <= 100));
	});

	it("accounts for the master list before calculating medium transcript capacity", () => {
		const transcript = Array.from(
			{ length: 20 },
			(_, index) => `latest-${index + 1}`,
		);
		const result = renderSubagentWatchLayout({
			width: 80,
			height: 21,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [target],
			selected: 0,
			transcript,
			transcriptState: "Transcript",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		assert.equal(result.kind, "medium");
		assert.equal(result.maxTop, transcript.length - result.bodyRows);
		assert.match(result.lines.join("\n"), /latest-20/);
	});

	it("wraps compact caller tasks and sanitizes corrupt run ids without legacy fallback", () => {
		const compactTarget = {
			...target,
			task: "Caller task remains readable on compact displays without injected execution instructions.",
			runId: "run\u001b[31m-id",
		};
		const compact = renderSubagentWatchLayout({
			width: 40,
			height: 24,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [compactTarget],
			selected: 0,
			transcript: [],
			transcriptState: "Waiting",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		const legacy = renderSubagentWatchLayout({
			width: 40,
			height: 24,
			theme,
			mode: "watch",
			help: false,
			loading: false,
			targets: [{ ...target, task: undefined }],
			selected: 0,
			transcript: [],
			transcriptState: "Waiting",
			follow: true,
			scrollTop: 0,
			duration: () => "10ms",
		});
		const text = compact.lines.join("\n");
		assert.match(text, /Caller task remains readable/);
		assert.match(text, /without injected/);
		assert.match(text, /execution instructions/);
		assert.equal(text.includes("\u001b[31m"), false);
		assert.match(legacy.lines.join("\n"), /No caller task metadata was/);
		assert.match(legacy.lines.join("\n"), /recorded\./);
	});
});
