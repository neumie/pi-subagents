/**
 * Durable async status artifacts retain only a caller-facing task preview.
 * The preview is capped at this UTF-8 byte size, is never derived from the
 * fork execution prompt, and has an explicit omission marker when truncated.
 */
export const ASYNC_TASK_PREVIEW_MAX_BYTES = 4_096;
const TRUNCATION_MARKER = "… [truncated]";

/** Truncate on code-point boundaries and include the omission marker in maxBytes. */
export function truncateUtf8WithMarker(
	value: string,
	maxBytes: number,
): string {
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	if (maxBytes < markerBytes) return TRUNCATION_MARKER.slice(0, maxBytes);
	let bytes = 0;
	const characters: string[] = [];
	const contentLimit = maxBytes - markerBytes;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) {
			while (bytes > contentLimit) {
				const removed = characters.pop();
				if (removed === undefined) break;
				bytes -= Buffer.byteLength(removed, "utf8");
			}
			return `${characters.join("")}${TRUNCATION_MARKER}`;
		}
		characters.push(character);
		bytes += characterBytes;
	}
	return characters.join("");
}

export function toAsyncTaskPreview(
	task: string | undefined,
): string | undefined {
	return task === undefined
		? undefined
		: truncateUtf8WithMarker(task, ASYNC_TASK_PREVIEW_MAX_BYTES);
}
