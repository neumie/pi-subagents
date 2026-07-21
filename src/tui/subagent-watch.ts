import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatDuration } from "../shared/formatters.ts";
import {
	WATCH_OVERLAY_OPTIONS,
	overlayHeightBudget,
	renderSubagentWatchLayout,
	type WatchLayoutResult,
	type WatchTheme,
} from "./subagent-watch-layout.ts";
import {
	discoverSubagentWatchTargets,
	readSubagentOutputTailSnapshot,
	sanitizeSubagentText,
	type SubagentOutputTailSnapshot,
	type SubagentWatchOptions,
	type SubagentWatchTarget,
} from "./subagent-watch-data.ts";

const REFRESH_INTERVAL_MS = 200;
const TARGET_REFRESH_INTERVAL_MS = 1_000;
type Theme = ExtensionContext["ui"]["theme"];

export interface SubagentWatchRuntime {
	now(): number;
	discover(options: SubagentWatchOptions): SubagentWatchTarget[];
	readOutput(path: string): SubagentOutputTailSnapshot;
	stat(path: string): { size: number; mtimeMs: number } | undefined;
	queueMicrotask(callback: () => void): void;
	setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
}

const defaultRuntime: SubagentWatchRuntime = {
	now: () => Date.now(),
	discover: discoverSubagentWatchTargets,
	readOutput: readSubagentOutputTailSnapshot,
	stat: (outputPath) => {
		try {
			const stat = fs.statSync(outputPath);
			return { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch {
			return undefined;
		}
	},
	queueMicrotask,
	setInterval,
	clearInterval,
};

function active(target: SubagentWatchTarget | undefined): boolean {
	return (
		target?.status === "queued" ||
		target?.status === "running" ||
		target?.status === "paused"
	);
}

function targetDuration(target: SubagentWatchTarget, now: number): string {
	if (target.durationMs !== undefined)
		return formatDuration(Math.max(0, target.durationMs));
	return `run elapsed ${formatDuration(Math.max(0, (target.endedAt ?? now) - target.startedAt))}`;
}

function outputState(
	target: SubagentWatchTarget | undefined,
	lines: string[],
	loading: boolean,
): string {
	if (loading) return "Loading async subagents…";
	if (!target)
		return "No async subagents in this session. This view updates automatically.";
	if (lines.length > 0) return "Transcript";
	if (active(target)) return "Waiting for first output…";
	if (target.status === "complete" || target.status === "completed")
		return "This child completed without transcript output.";
	if (target.error) return sanitizeSubagentText(target.error);
	return "This child ended without transcript output.";
}

export class SubagentWatchView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: SubagentWatchOptions;
	private readonly done: () => void;
	private readonly runtime: SubagentWatchRuntime;
	private targets: SubagentWatchTarget[] = [];
	private selected = 0;
	private mode: "select" | "watch" = "select";
	private help = false;
	private followOutput = true;
	private scrollTop = 0;
	private outputLines: string[] = [];
	private outputSignature: string | undefined;
	private outputOmitted = false;
	private outputReadError: string | undefined;
	private readonly lastGoodOutput = new Map<string, { lines: string[]; omitted: boolean }>();
	private lastTargetRefresh = 0;
	private lastSuccessfulTargetRefreshAt: number | undefined;
	private refreshError: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private lastLayout: WatchLayoutResult | undefined;
	private lastDisplaySignature = "";
	private loading: boolean;

	constructor(
		tui: TUI,
		theme: Theme,
		options: SubagentWatchOptions,
		done: () => void,
		initialTargets?: SubagentWatchTarget[],
		runtime: Partial<SubagentWatchRuntime> = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.done = done;
		this.runtime = { ...defaultRuntime, ...runtime };
		this.loading = initialTargets === undefined;
		if (initialTargets) {
			this.targets = initialTargets;
			this.lastSuccessfulTargetRefreshAt = this.runtime.now();
		} else {
			// The custom-component seam can render immediately after construction.
			// Discover synchronously so its first frame is useful rather than a
			// transient loading placeholder.
			this.refreshTargets(true);
		}
		this.refreshOutput(this.currentTarget());
		this.lastTargetRefresh = this.runtime.now();
		this.timer = this.runtime.setInterval(
			() => this.refresh(),
			REFRESH_INTERVAL_MS,
		);
		this.timer.unref?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer !== undefined) this.runtime.clearInterval(this.timer);
		this.timer = undefined;
		this.lastGoodOutput.clear();
	}

	invalidate(): void {
		this.lastLayout = undefined;
		this.lastDisplaySignature = "";
	}

	private currentTarget(): SubagentWatchTarget | undefined {
		return this.targets[this.selected];
	}

	private refreshTargets(initial = false): boolean {
		const selectedKey = this.currentTarget()?.key;
		try {
			const next = this.runtime.discover(this.options);
			// Every discovered field can be rendered.  Do not suppress a repaint for
			// model, token, path, or tool-argument-only status updates.
			const signature = JSON.stringify(next);
			const previous = JSON.stringify(this.targets);
			this.targets = next;
			const nextIndex = selectedKey
				? next.findIndex((target) => target.key === selectedKey)
				: -1;
			this.selected =
				nextIndex >= 0
					? nextIndex
					: Math.min(this.selected, Math.max(0, next.length - 1));
			this.refreshError = undefined;
			this.loading = false;
			this.lastSuccessfulTargetRefreshAt = this.runtime.now();
			return initial || signature !== previous;
		} catch (error) {
			this.loading = false;
			const message = sanitizeSubagentText(
				error instanceof Error ? error.message : String(error),
			);
			const changed = message !== this.refreshError;
			this.refreshError = message;
			return changed || initial;
		}
	}

	private refreshOutput(target: SubagentWatchTarget | undefined): boolean {
		if (!target) {
			if (this.outputSignature === "none") return false;
			this.outputSignature = "none";
			this.outputLines = [];
			this.outputOmitted = false;
			this.outputReadError = undefined;
			return true;
		}
		const asyncDir = path.resolve(target.asyncDir);
		const outputPath = path.resolve(asyncDir, `output-${target.index}.log`);
		// Defense in depth: artifacts are runtime input, never permit a target to
		// direct this read outside its own async-run directory.
		if (path.dirname(outputPath) !== asyncDir) {
			this.outputLines = [];
			this.outputOmitted = false;
			this.outputReadError = "Unsafe transcript path rejected.";
			return true;
		}
		const stat = this.runtime.stat(outputPath);
		const signature = `${target.key}:${stat ? `${stat.size}:${stat.mtimeMs}` : "missing"}:${JSON.stringify([target.recentOutput, target.error])}`;
		// A failed read deliberately does not advance outputSignature: the same
		// artifact signature must be retried on the next low-churn poll.
		if (signature === this.outputSignature && !this.outputReadError)
			return false;
		let snapshot: SubagentOutputTailSnapshot;
		try {
			snapshot = this.runtime.readOutput(outputPath);
		} catch (error) {
			snapshot = {
				lines: [],
				omittedBytes: false,
				omittedLines: false,
				error: sanitizeSubagentText(
					error instanceof Error ? error.message : String(error),
				),
			};
		}
		const previous = JSON.stringify([
			this.outputLines,
			this.outputOmitted,
			this.outputReadError,
		]);
		if (snapshot.error) {
			this.outputReadError = sanitizeSubagentText(snapshot.error);
			const lastGood = this.lastGoodOutput.get(target.key);
			this.outputLines = lastGood?.lines ?? [];
			this.outputOmitted = lastGood?.omitted ?? false;
			return (
				previous !==
				JSON.stringify([
					this.outputLines,
					this.outputOmitted,
					this.outputReadError,
				])
			);
		}
		this.outputSignature = signature;
		this.outputReadError = undefined;
		this.outputOmitted = snapshot.omittedBytes || snapshot.omittedLines;
		this.outputLines =
			snapshot.lines.length > 0
				? snapshot.lines
				: [
						...(target.recentOutput ?? []),
						...(target.error ? [`Error: ${target.error}`] : []),
					].map(sanitizeSubagentText);
		this.lastGoodOutput.set(target.key, { lines: this.outputLines, omitted: this.outputOmitted });
		return (
			previous !==
			JSON.stringify([
				this.outputLines,
				this.outputOmitted,
				this.outputReadError,
			])
		);
	}

	private displaySignature(): string {
		const now = this.runtime.now();
		return JSON.stringify({
			targets: this.targets,
			activeElapsedSeconds: this.targets.map((target) =>
				active(target) && target.durationMs === undefined
					? Math.floor(Math.max(0, now - target.startedAt) / 1_000)
					: undefined,
			),
			selected: this.selected,
			mode: this.mode,
			help: this.help,
			follow: this.followOutput,
			scroll: this.scrollTop,
			output: this.outputSignature,
			readError: this.outputReadError,
			refreshError: this.refreshError,
			loading: this.loading,
		});
	}

	private requestRenderIfChanged(force = false): void {
		const signature = this.displaySignature();
		if (force || signature !== this.lastDisplaySignature) {
			this.lastDisplaySignature = signature;
			this.tui.requestRender();
		}
	}

	private refresh(): void {
		if (this.disposed) return;
		const now = this.runtime.now();
		let changed = false;
		if (now - this.lastTargetRefresh >= TARGET_REFRESH_INTERVAL_MS) {
			changed = this.refreshTargets();
			this.lastTargetRefresh = now;
		}
		changed = this.refreshOutput(this.currentTarget()) || changed;
		// displaySignature only changes on elapsed-second boundaries, so any
		// visible child with a clock-derived duration repaints without turning the
		// 200ms output poll into render churn—even when a terminal sibling is selected.
		if (this.targets.some((target) => active(target) && target.durationMs === undefined)) changed = true;
		if (changed) this.requestRenderIfChanged();
	}

	private selectIndex(index: number): void {
		if (this.targets.length === 0) return;
		this.selected = Math.max(0, Math.min(index, this.targets.length - 1));
		this.followOutput = true;
		this.scrollTop = 0;
		this.outputSignature = undefined;
		this.refreshOutput(this.currentTarget());
	}

	private changeSelection(delta: number): void {
		if (this.targets.length === 0) return;
		this.selectIndex((this.selected + delta + this.targets.length) % this.targets.length);
	}

	private scroll(delta: number): void {
		const maxTop = this.lastLayout?.maxTop ?? 0;
		if (delta < 0) this.followOutput = false;
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop + delta));
		if (this.scrollTop >= maxTop && delta > 0) this.followOutput = true;
	}

	handleInput(data: string): void {
		if (this.help && matchesKey(data, "escape")) {
			this.help = false;
			this.requestRenderIfChanged(true);
			return;
		}
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			data.toLowerCase() === "q"
		) {
			this.done();
			return;
		}
		if (data === "?") {
			this.help = !this.help;
			this.requestRenderIfChanged(true);
			return;
		}
		if (this.mode === "select") {
			if (matchesKey(data, "up") || data.toLowerCase() === "k")
				this.changeSelection(-1);
			else if (matchesKey(data, "down") || data.toLowerCase() === "j")
				this.changeSelection(1);
			else if (matchesKey(data, "home"))
				this.selectIndex(0);
			else if (matchesKey(data, "end"))
				this.selectIndex(this.targets.length - 1);
			else if (matchesKey(data, "return") && this.targets.length > 0)
				this.mode = "watch";
			this.requestRenderIfChanged(true);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab"))
			this.changeSelection(-1);
		else if (matchesKey(data, "right") || matchesKey(data, "tab"))
			this.changeSelection(1);
		else if (matchesKey(data, "up") || data.toLowerCase() === "k")
			this.scroll(-1);
		else if (matchesKey(data, "down") || data.toLowerCase() === "j")
			this.scroll(1);
		else if (matchesKey(data, "pageUp"))
			this.scroll(-(this.lastLayout?.bodyRows ?? 10));
		else if (matchesKey(data, "pageDown"))
			this.scroll(this.lastLayout?.bodyRows ?? 10);
		else if (matchesKey(data, "home")) {
			this.followOutput = false;
			this.scrollTop = 0;
		} else if (matchesKey(data, "end") || data.toLowerCase() === "f") {
			this.followOutput = true;
			this.scrollTop = this.lastLayout?.maxTop ?? 0;
		} else if (matchesKey(data, "backspace") || data.toLowerCase() === "b")
			this.mode = "select";
		this.requestRenderIfChanged(true);
	}

	render(width: number): string[] {
		const height = overlayHeightBudget(this.tui.terminal.rows);
		const target = this.currentTarget();
		const result = renderSubagentWatchLayout({
			width,
			height,
			now: this.runtime.now(),
			theme: this.theme as WatchTheme,
			mode: this.mode,
			help: this.help,
			loading: this.loading,
			targets: this.targets,
			selected: this.selected,
			transcript: this.outputLines,
			transcriptState: outputState(target, this.outputLines, this.loading),
			transcriptWarning: this.outputReadError
				? `Transcript read failed · ${this.outputLines.length ? "showing last known output" : sanitizeSubagentText(this.outputReadError)}`
				: undefined,
			omitted: this.outputOmitted,
			follow: this.followOutput,
			scrollTop: this.scrollTop,
			lastSuccessfulRefreshAt: this.lastSuccessfulTargetRefreshAt,
			refreshError: this.refreshError,
			duration: (item) => targetDuration(item, this.runtime.now()),
		});
		this.lastLayout = result;
		if (this.followOutput) this.scrollTop = result.maxTop;
		else this.scrollTop = Math.min(this.scrollTop, result.maxTop);
		return result.lines;
	}
}

export async function openSubagentWatch(
	ctx: ExtensionContext,
	options: SubagentWatchOptions,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/subagents-watch requires an interactive Pi session.",
			"warning",
		);
		return;
	}
	let view: SubagentWatchView | undefined;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				view = new SubagentWatchView(tui, theme, options, () =>
					done(undefined),
				);
				return view;
			},
			{ overlay: true, overlayOptions: WATCH_OVERLAY_OPTIONS },
		);
	} finally {
		view?.dispose();
	}
}
