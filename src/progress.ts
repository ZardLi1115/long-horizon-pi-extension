import type { ProgressState } from "./types.js";
import { formatList, parseListItem, parseScalar } from "./yaml.js";

const LIST_FIELDS = new Set(["done", "blocker", "tried", "next"]);
const EMPTY_PROGRESS: ProgressState = {
	active: null,
	attempts: 0,
	done: [],
	blocker: [],
	tried: [],
	next: [],
	unknown: [],
};

export function emptyProgress(): ProgressState {
	return { ...EMPTY_PROGRESS, done: [], blocker: [], tried: [], next: [], unknown: [] };
}

export function withDefaultActive(state: ProgressState, orderedSectionIds: string[]): ProgressState {
	if (state.active) return { ...state, done: [...state.done], blocker: [...state.blocker], tried: [...state.tried], next: [...state.next], unknown: [...state.unknown] };
	return {
		...state,
		active: orderedSectionIds.find((id) => !state.done.includes(id)) ?? null,
		done: [...state.done],
		blocker: [...state.blocker],
		tried: [...state.tried],
		next: [...state.next],
		unknown: [...state.unknown],
	};
}

export function parseProgress(source: string): ProgressState {
	const state = emptyProgress();
	const lines = source.split(/\r?\n/);
	let activeList: keyof ProgressState | null = null;
	for (const line of lines) {
		if (!line.trim()) {
			activeList = null;
			continue;
		}
		const listItem = parseListItem(line);
		if (activeList && listItem !== null) {
			(state[activeList] as string[]).push(listItem);
			continue;
		}
		const scalarMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
		if (!scalarMatch) {
			state.unknown.push(line);
			activeList = null;
			continue;
		}
		const [, key, rawValue = ""] = scalarMatch;
		if (LIST_FIELDS.has(key)) {
			activeList = key as keyof ProgressState;
			if (rawValue.trim()) state.unknown.push(line);
			continue;
		}
		if (key === "active") {
			state.active = rawValue.trim() ? parseScalar(rawValue) : null;
			activeList = null;
			continue;
		}
		if (key === "attempts") {
			const attempts = Number.parseInt(rawValue.trim(), 10);
			if (Number.isFinite(attempts) && attempts >= 0) state.attempts = attempts;
			else state.unknown.push(line);
			activeList = null;
			continue;
		}
		state.unknown.push(line);
		activeList = null;
	}
	return state;
}

export function serializeProgress(state: ProgressState): string {
	const lines = [`active: ${state.active ?? ""}`, `attempts: ${state.attempts}`, ""];
	const fields = ["done", "blocker", "tried", "next"] as const;
	for (const [index, field] of fields.entries()) {
		lines.push(`${field}:`, ...formatList(state[field]), "");
		if (index === 3 && state.unknown.length > 0) lines.push(...state.unknown, "");
	}
	return `${lines.join("\n")}`;
}

export function incrementAttempt(state: ProgressState, blocker?: string): ProgressState {
	return {
		...state,
		attempts: state.attempts + 1,
		blocker: blocker ? [blocker] : [...state.blocker],
		done: [...state.done],
		tried: [...state.tried],
		next: [...state.next],
		unknown: [...state.unknown],
	};
}

export function advanceProgress(state: ProgressState, orderedSectionIds: string[], note?: string): ProgressState {
	const done = [...new Set([...state.done, ...(state.active ? [state.active] : [])])];
	const nextActive = orderedSectionIds.find((id) => !done.includes(id)) ?? null;
	return {
		...state,
		active: nextActive,
		attempts: 0,
		done,
		blocker: [],
		tried: [],
		next: note ? [note] : [],
		unknown: [...state.unknown],
	};
}

export function reopenProgress(state: ProgressState, id: string, reason?: string): ProgressState {
	return {
		...state,
		active: id,
		attempts: 0,
		done: state.done.filter((doneId) => doneId !== id),
		blocker: reason ? [reason] : [],
		tried: [],
		next: [],
		unknown: [...state.unknown],
	};
}
