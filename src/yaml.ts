export function parseScalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function parseListItem(line: string): string | null {
	const match = /^\s*-\s+(.*)$/.exec(line);
	return match ? parseScalar(match[1]) : null;
}

export function formatList(values: string[]): string[] {
	return values.map((value) => `  - ${value}`);
}
