import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	boundSubagentMetadata,
	sanitizeSubagentText,
	type SubagentWatchTarget,
} from "./subagent-watch-data.ts";

export const WATCH_OVERLAY_OPTIONS = {
	width: "92%" as const,
	maxHeight: "88%" as const,
	anchor: "center" as const,
	margin: 1,
};

export interface WatchTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface WatchLayoutInput {
	width: number;
	height: number;
	theme: WatchTheme;
	mode: "select" | "watch";
	help: boolean;
	loading: boolean;
	targets: SubagentWatchTarget[];
	selected: number;
	transcript: string[];
	transcriptState: string;
	transcriptWarning?: string;
	omitted?: boolean;
	follow: boolean;
	scrollTop: number;
	lastSuccessfulRefreshAt?: number;
	refreshError?: string;
	now?: number;
	duration: (target: SubagentWatchTarget) => string;
}

export interface WatchLayoutResult {
	lines: string[];
	bodyRows: number;
	lineCount: number;
	maxTop: number;
	kind: "wide" | "medium" | "compact" | "tiny";
}

export function overlayHeightBudget(terminalRows: number): number {
	return Math.max(
		1,
		Math.min(Math.floor(terminalRows * 0.88), Math.max(1, terminalRows - 2)),
	);
}

export function padVisible(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function frameTop(title: string, width: number): string {
	if (width < 4) return truncateToWidth("…", Math.max(1, width));
	const inner = width - 2;
	const text = sanitizeSubagentText(title);
	const label = text ? ` ${text} ` : "";
	return `╭${truncateToWidth(label, inner, "").padEnd(inner, "─")}╮`;
}

export function frameRow(content: string, width: number): string {
	if (width < 4) return truncateToWidth("…", Math.max(1, width));
	return `│${padVisible(content, width - 2)}│`;
}

export function frameBottom(footer: string, width: number): string {
	if (width < 4) return truncateToWidth("…", Math.max(1, width));
	const inner = width - 2;
	const text = footer ? ` ${sanitizeSubagentText(footer)} ` : "";
	return `╰${truncateToWidth(text, inner, "").padEnd(inner, "─")}╯`;
}

/** Older artifacts have no caller task; labels and phases are not task content. */
function taskFor(target: SubagentWatchTarget): string {
	return target.task === undefined
		? ""
		: sanitizeSubagentText(boundSubagentMetadata(target.task)).replace(/\s+/g, " ").trim();
}

function status(target: SubagentWatchTarget): string {
	return sanitizeSubagentText(String(target.status)).toUpperCase();
}

function activityAge(input: WatchLayoutInput, timestamp: number | undefined): string {
	if (timestamp === undefined || input.now === undefined) return "";
	const seconds = Math.max(0, Math.floor((input.now - timestamp) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

function oneLine(value: string | undefined): string {
	return value ? sanitizeSubagentText(boundSubagentMetadata(value, 512)).replace(/\s+/g, " ").trim() : "";
}

function isActiveTarget(target: SubagentWatchTarget): boolean {
	return target.status === "queued" || target.status === "running" || target.status === "paused";
}

function activityHeadline(input: WatchLayoutInput, target: SubagentWatchTarget): string {
	if (target.currentTool) {
		const age = activityAge(input, target.currentToolStartedAt);
		return `${oneLine(target.currentTool).toUpperCase()}${age ? ` · ${age} elapsed` : ""}`;
	}
	if (target.status === "queued") return "Waiting to start";
	if (target.status === "paused") return "Paused by supervisor";
	if (target.activityState === "needs_attention") return "Waiting for attention";
	if (target.status === "running") {
		const age = activityAge(input, target.lastActivityAt);
		return `Thinking / preparing next action${age ? ` · active ${age} ago` : ""}`;
	}
	const recent = target.recentTools?.at(-1);
	if (!recent) return "No recorded tool activity";
	const age = activityAge(input, recent.endMs);
	return `${oneLine(recent.tool).toUpperCase()}${age ? ` · ${age} ago` : ""}`;
}

function activitySubject(target: SubagentWatchTarget): string {
	if (!target.currentTool) return oneLine(target.recentTools?.at(-1)?.args);
	const currentPath = oneLine(target.currentPath);
	const argumentsText = oneLine(target.currentToolArgs);
	if (!currentPath) return argumentsText;
	if (!argumentsText || argumentsText === currentPath || argumentsText.includes(currentPath))
		return argumentsText || currentPath;
	return `${currentPath} · ${argumentsText}`;
}

function recentActivityLines(input: WatchLayoutInput, target: SubagentWatchTarget, width: number): string[] {
	return (target.recentTools ?? [])
		.slice(-3)
		.reverse()
		.map((entry) => {
			const age = activityAge(input, entry.endMs);
			const summary = [oneLine(entry.tool), oneLine(entry.args), age && `${age} ago`]
				.filter(Boolean)
				.join(" · ");
			return truncateToWidth(`  ↳ ${summary}`, Math.max(1, width));
		});
}

function stateRole(
	target: SubagentWatchTarget,
): "success" | "warning" | "error" | "muted" {
	if (
		target.status === "running" ||
		target.status === "complete" ||
		target.status === "completed"
	)
		return "success";
	if (target.status === "failed" || target.status === "stopped") return "error";
	if (target.status === "queued" || target.status === "paused")
		return "warning";
	return "muted";
}

function selectedRow(
	input: WatchLayoutInput,
	target: SubagentWatchTarget,
	index: number,
	width: number,
): string {
	const marker = index === input.selected ? input.theme.fg("accent", "›") : " ";
	const state = input.theme.fg(stateRole(target), status(target));
	const suffix = input.duration(target);
	const task =
		taskFor(target) ||
		sanitizeSubagentText(target.label ?? target.phase ?? target.agent);
	const prefix = `${marker} ${sanitizeSubagentText(target.label ?? target.agent)} · ${state} · `;
	const reserve = visibleWidth(prefix) + visibleWidth(suffix) + 3;
	const row = `${prefix}${truncateToWidth(task, Math.max(1, width - reserve))} · ${suffix}`;
	const padded = padVisible(row, width);
	return index === input.selected
		? input.theme.bg("selectedBg", padded)
		: padded;
}

function groupedTargets(
	targets: SubagentWatchTarget[],
): Array<{
	title: string;
	entries: Array<{ target: SubagentWatchTarget; index: number }>;
}> {
	const active: Array<{ target: SubagentWatchTarget; index: number }> = [];
	const recent: Array<{ target: SubagentWatchTarget; index: number }> = [];
	targets.forEach((target, index) => {
		(target.status === "queued" ||
		target.status === "running" ||
		target.status === "paused"
			? active
			: recent
		).push({ target, index });
	});
	return [
		{ title: `ACTIVE ${active.length}`, entries: active },
		{ title: `RECENT ${recent.length}`, entries: recent },
	].filter((group) => group.entries.length > 0);
}

function masterLines(
	input: WatchLayoutInput,
	width: number,
	rows: number,
): string[] {
	if (input.loading)
		return [input.theme.fg("muted", "Loading async subagents…")];
	if (input.targets.length === 0)
		return [
			input.theme.fg(
				input.refreshError ? "warning" : "muted",
				input.refreshError
					? `Status refresh failed: ${sanitizeSubagentText(input.refreshError)}`
					: "No async subagents in this session. This view updates automatically.",
			),
		];
	const entries: Array<{ line: string; selected: boolean }> = groupedTargets(input.targets).flatMap((group) => [
		{ line: input.theme.fg("dim", group.title), selected: false },
		...group.entries.flatMap(({ target, index }) => [
			{ line: selectedRow(input, target, index, width), selected: index === input.selected },
			...(index === input.selected
				? [{ line: input.theme.fg(
						"accent",
						truncateToWidth(`  ${isActiveTarget(target) ? "● NOW" : "○ LAST"} · ${activityHeadline(input, target)}`, width),
					), selected: false }]
				: []),
		]),
	]);
	const selectedRowIndex = entries.findIndex((entry) => entry.selected);
	const start = Math.max(
		0,
		Math.min(
			Math.max(0, selectedRowIndex - rows + 2),
			Math.max(0, entries.length - rows),
		),
	);
	const visible = entries.slice(start, start + Math.max(1, rows)).map((entry) => entry.line);
	if (entries.length > rows && visible.length > 0)
		visible[0] = input.theme.fg(
			"dim",
			`showing ${start + 1}–${Math.min(entries.length, start + rows)}/${entries.length}`,
		);
	return visible;
}

function detailLines(input: WatchLayoutInput, width: number): string[] {
	const target = input.targets[input.selected];
	if (!target) return [sanitizeSubagentText(input.transcriptState)];
	const childCount = input.targets.filter(
		(item) => item.runId === target.runId,
	).length;
	const childPosition = input.targets.filter(
		(item, index) => item.runId === target.runId && index <= input.selected,
	).length;
	const task = taskFor(target);
	const subject = activitySubject(target);
	const recent = recentActivityLines(input, target, width);
	const activityLabel = isActiveTarget(target) ? "● NOW" : "○ LAST";
	const activityRole = target.status === "failed" || target.status === "stopped"
		? "error"
		: isActiveTarget(target)
			? "accent"
			: "muted";
	const lines = [
		input.theme.bold(
			`${sanitizeSubagentText(target.label ?? target.agent)} · child ${childPosition}/${childCount}`,
		),
		[
			input.theme.fg(stateRole(target), status(target)),
			input.duration(target),
			target.model && sanitizeSubagentText(target.model),
			target.thinking && sanitizeSubagentText(target.thinking),
			target.tokens ? `${target.tokens.total} tok` : undefined,
		]
			.filter(Boolean)
			.join(" · "),
		input.theme.bold(
			`${input.theme.fg(activityRole, activityLabel)} · ${activityHeadline(input, target)}`,
		),
	];
	if (subject)
		lines.push(
			...wrapTextWithAnsi(subject, Math.max(1, width - 2))
				.slice(0, 2)
				.map((line) => `  ${line}`),
		);
	if (recent.length > 0) lines.push("Recent activity:", ...recent);
	lines.push(
		"Task:",
		...wrapTextWithAnsi(
			task || "No caller task metadata was recorded.",
			Math.max(1, width - 2),
		).map((line) => `  ${line}`),
		[
			target.turnCount !== undefined ? `${target.turnCount} turns` : undefined,
			target.toolCount !== undefined ? `${target.toolCount} tools` : undefined,
			sanitizeSubagentText(target.mode),
			sanitizeSubagentText(target.runId),
		]
			.filter(Boolean)
			.join(" · "),
	);
	return lines.filter(Boolean);
}

function transcript(
	input: WatchLayoutInput,
	width: number,
	bodyRows: number,
): { lines: string[]; lineCount: number; maxTop: number; label: string } {
	const wrapped = input.transcript.flatMap((line) =>
		wrapTextWithAnsi(sanitizeSubagentText(line) || " ", Math.max(1, width)),
	);
	const lineCount = wrapped.length;
	const maxTop = Math.max(0, lineCount - bodyRows);
	const top = input.follow
		? maxTop
		: Math.min(Math.max(0, input.scrollTop), maxTop);
	return {
		lines: wrapped.slice(top, top + bodyRows),
		lineCount,
		maxTop,
		label: input.follow
			? "Transcript · FOLLOW"
			: `Transcript · PAUSED · ${Math.max(0, lineCount - (top + bodyRows))} new`,
	};
}

function fittedDetail(lines: string[], available: number): string[] {
	if (lines.length <= available) return lines;
	return [
		...lines.slice(0, Math.max(0, available - 1)),
		"… resize to view remaining task details",
	];
}

function stackedWatchContent(
	input: WatchLayoutInput,
	inner: number,
	contentRows: number,
	kind: "medium" | "compact",
): WatchLayoutResult {
	const selected = input.targets[input.selected];
	const listRows =
		kind === "medium"
			? Math.min(
					Math.max(2, Math.floor(contentRows * 0.28)),
					Math.max(1, contentRows - 5),
				)
			: 0;
	const titleRows =
		kind === "compact"
			? [
					selected
						? `${sanitizeSubagentText(selected.label ?? selected.agent)} · ${status(selected)} · ${input.duration(selected)}`
						: "No selected child",
				]
			: [
					input.theme.fg("accent", "Subagents"),
					...masterLines(input, inner, listRows),
				];
	const details = detailLines(input, inner);
	// Reserve a labeled transcript and one readable visual row.  Nothing is
	// globally truncated after this allocation, so bodyRows exactly matches rows
	// that reach the screen.
	const chromeRows = titleRows.length + 2 + (input.omitted ? 1 : 0);
	const visibleDetails = fittedDetail(
		details,
		Math.max(0, contentRows - chromeRows - 1),
	);
	const bodyRows = Math.max(
		1,
		contentRows - chromeRows - visibleDetails.length,
	);
	const output = transcript(input, inner, bodyRows);
	const lines = [
		...titleRows,
		...visibleDetails,
		output.label,
		input.transcriptWarning ?? sanitizeSubagentText(input.transcriptState),
	];
	if (input.omitted)
		lines.push(input.theme.fg("warning", "Earlier output omitted"));
	lines.push(...output.lines);
	return {
		lines,
		bodyRows,
		lineCount: output.lineCount,
		maxTop: output.maxTop,
		kind,
	};
}

function wideWatchContent(
	input: WatchLayoutInput,
	inner: number,
	contentRows: number,
): WatchLayoutResult {
	const separatorWidth = 3;
	const leftWidth = Math.min(44, Math.max(30, Math.floor((inner - separatorWidth) * 0.38)));
	const rightWidth = Math.max(12, inner - leftWidth - separatorWidth);
	const details = detailLines(input, rightWidth);
	const chromeRows = 2 + (input.omitted ? 1 : 0);
	const visibleDetails = fittedDetail(
		details,
		Math.max(0, contentRows - chromeRows - 1),
	);
	const bodyRows = Math.max(
		1,
		contentRows - chromeRows - visibleDetails.length,
	);
	const output = transcript(input, rightWidth, bodyRows);
	const left = [
		input.theme.fg("accent", "Subagents"),
		...masterLines(input, leftWidth, Math.max(1, contentRows - 1)),
	];
	const right = [
		input.theme.fg("accent", output.label),
		...visibleDetails,
		input.transcriptWarning ?? sanitizeSubagentText(input.transcriptState),
	];
	if (input.omitted)
		right.push(input.theme.fg("warning", "Earlier output omitted"));
	right.push(...output.lines);
	const lines = Array.from(
		{ length: contentRows },
		(_, index) =>
			`${padVisible(left[index] ?? "", leftWidth)} │ ${padVisible(right[index] ?? "", rightWidth)}`,
	);
	return {
		lines,
		bodyRows,
		lineCount: output.lineCount,
		maxTop: output.maxTop,
		kind: "wide",
	};
}

function helpLines(input: WatchLayoutInput, width: number): string[] {
	const text =
		input.mode === "select"
			? [
					"READ ONLY HELP",
					"↑/↓ or J/K select · Home/End first/last · Enter inspect",
					"Esc closes help first · Q/Ctrl+C closes view",
				]
			: [
					"READ ONLY HELP",
					"←/→ or Tab switch child · ↑/↓ or J/K scroll · PgUp/PgDn page",
					"Home oldest · End/F follow · B/Backspace list",
					"Esc closes help first · Q/Ctrl+C closes view",
				];
	return text.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

export function renderSubagentWatchLayout(
	input: WatchLayoutInput,
): WatchLayoutResult {
	const width = Math.max(0, input.width);
	const height = Math.max(0, input.height);
	if (width < 4 || height < 3)
		return {
			lines: [truncateToWidth("… resize", Math.max(1, width))].slice(
				0,
				Math.max(1, height),
			),
			bodyRows: 0,
			lineCount: 0,
			maxTop: 0,
			kind: "tiny",
		};
	const inner = width - 2;
	const contentRows = height - 2;
	const kind: WatchLayoutResult["kind"] =
		width >= 96 && height >= 16
			? "wide"
			: width >= 56 && height >= 18
				? "medium"
				: "compact";
	const footer = input.help
		? "Esc close help · ? hide help"
		: input.mode === "select"
			? "Esc close · ? help · ↑/↓ select · Enter watch"
			: "Esc close · ? help · ↑/↓ scroll · End/F follow · B list";
	const stale = Boolean(
		input.refreshError && input.targets.length > 0 && !input.help,
	);
	const layoutRows = Math.max(1, contentRows - (stale ? 1 : 0));
	let result: WatchLayoutResult;
	if (input.help) {
		const lines = helpLines(input, inner).slice(0, layoutRows);
		result = { lines, bodyRows: 0, lineCount: 0, maxTop: 0, kind };
	} else if (input.mode === "select") {
		const lines = [
			input.theme.fg("accent", "Subagents"),
			...masterLines(input, inner, Math.max(1, layoutRows - 1)),
		];
		result = { lines, bodyRows: 0, lineCount: 0, maxTop: 0, kind };
	} else if (kind === "wide") {
		result = wideWatchContent(input, inner, layoutRows);
	} else {
		result = stackedWatchContent(input, inner, layoutRows, kind);
	}
	if (stale)
		result.lines.unshift(
			input.theme.fg(
				"warning",
				`STALE · Status refresh failed${input.lastSuccessfulRefreshAt ? ` · showing data from ${new Date(input.lastSuccessfulRefreshAt).toISOString().slice(11, 19)}Z` : ""}`,
			),
		);
	const rows = result.lines.slice(0, contentRows);
	while (rows.length < contentRows) rows.push("");
	return {
		...result,
		lines: [
			frameTop("Subagents · READ ONLY", width),
			...rows.map((line) => frameRow(line, width)),
			frameBottom(width < 24 ? "Esc" : footer, width),
		],
	};
}
