export type StatusType = "TODO" | "DONE" | "IN_PROGRESS" | "ON_HOLD" | "CANCELLED" | "NON_TASK" | "EMPTY";

export interface StatusConfiguration {
	symbol: string;
	name: string;
	nextStatusSymbol: string;
	availableAsCommand: boolean;
	type: StatusType;
}

export interface StatusSettings {
	coreStatuses: StatusConfiguration[];
	customStatuses: StatusConfiguration[];
}

export const DEFAULT_STATUS_SETTINGS: StatusSettings = {
	coreStatuses: [
		{symbol: " ", name: "Todo", nextStatusSymbol: "x", availableAsCommand: true, type: "TODO"},
		{symbol: "x", name: "Done", nextStatusSymbol: " ", availableAsCommand: true, type: "DONE"},
	],
	customStatuses: [
		{symbol: "/", name: "In progress", nextStatusSymbol: "x", availableAsCommand: true, type: "IN_PROGRESS"},
		{symbol: "-", name: "Cancelled", nextStatusSymbol: " ", availableAsCommand: true, type: "CANCELLED"},
	],
};

const DEFAULT_TODO_STATUS = DEFAULT_STATUS_SETTINGS.coreStatuses[0] as StatusConfiguration;
const DEFAULT_DONE_STATUS = DEFAULT_STATUS_SETTINGS.coreStatuses[1] as StatusConfiguration;

export class StatusRegistry {
	private readonly bySymbol = new Map<string, StatusConfiguration>();

	constructor(settings: StatusSettings = DEFAULT_STATUS_SETTINGS) {
		this.set(settings);
	}

	set(settings: StatusSettings): void {
		this.bySymbol.clear();
		for (const status of [...settings.coreStatuses, ...settings.customStatuses]) {
			if (isValidStatusConfiguration(status) && !this.bySymbol.has(status.symbol)) {
				this.bySymbol.set(status.symbol, status);
			}
		}
		if (!this.bySymbol.has(" ")) {
			this.bySymbol.set(" ", DEFAULT_TODO_STATUS);
		}
		if (!this.bySymbol.has("x")) {
			this.bySymbol.set("x", DEFAULT_DONE_STATUS);
		}
	}

	get(symbol: string): StatusConfiguration {
		return this.bySymbol.get(symbol) ?? {
			symbol,
			name: `Unknown (${symbol || "empty"})`,
			nextStatusSymbol: "x",
			availableAsCommand: false,
			type: inferStatusType(symbol),
		};
	}

	next(status: StatusConfiguration): StatusConfiguration {
		return this.get(status.nextStatusSymbol);
	}

	recurrenceStatus(afterCompletedStatusSymbol: string): StatusConfiguration {
		let candidate = this.next(this.get(afterCompletedStatusSymbol));
		for (let index = 0; index < this.bySymbol.size + 1; index++) {
			if (candidate.type === "TODO" || candidate.type === "IN_PROGRESS") {
				return candidate;
			}
			candidate = this.next(candidate);
		}
		return this.get(" ");
	}
}

export function allStatuses(settings: StatusSettings): StatusConfiguration[] {
	return [...settings.coreStatuses, ...settings.customStatuses];
}

export function normalizeStatusSettings(value: unknown): StatusSettings | null {
	const maybe = value as Partial<StatusSettings> | undefined;
	if (!maybe || !Array.isArray(maybe.coreStatuses) || !Array.isArray(maybe.customStatuses)) {
		return null;
	}
	const coreStatuses = maybe.coreStatuses.filter(isValidStatusConfiguration);
	const customStatuses = maybe.customStatuses.filter(isValidStatusConfiguration);
	if (coreStatuses.length === 0) {
		return null;
	}
	return {coreStatuses, customStatuses};
}

function isValidStatusConfiguration(value: unknown): value is StatusConfiguration {
	const status = value as Partial<StatusConfiguration> | undefined;
	return Boolean(
		status &&
			typeof status.symbol === "string" &&
			status.symbol.length <= 1 &&
			typeof status.name === "string" &&
			typeof status.nextStatusSymbol === "string" &&
			status.nextStatusSymbol.length <= 1 &&
			typeof status.availableAsCommand === "boolean" &&
			isStatusType(status.type),
	);
}

function isStatusType(value: unknown): value is StatusType {
	return (
		value === "TODO" ||
		value === "DONE" ||
		value === "IN_PROGRESS" ||
		value === "ON_HOLD" ||
		value === "CANCELLED" ||
		value === "NON_TASK" ||
		value === "EMPTY"
	);
}

function inferStatusType(symbol: string): StatusType {
	if (symbol === "x" || symbol === "X") return "DONE";
	if (symbol === "/") return "IN_PROGRESS";
	if (symbol === "-") return "CANCELLED";
	if (symbol === "") return "EMPTY";
	return "TODO";
}
