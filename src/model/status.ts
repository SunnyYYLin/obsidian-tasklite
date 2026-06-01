export type StatusType = "TODO" | "DONE" | "IN_PROGRESS" | "ON_HOLD" | "CANCELLED" | "NON_TASK" | "EMPTY";

export interface StatusConfiguration {
	symbol: string;
	name: string;
	nextStatusSymbol: string;
	availableAsCommand: boolean;
	type: StatusType;
}

export class StatusRegistry {
	private readonly bySymbol = new Map<string, StatusConfiguration>([
		[" ", {symbol: " ", name: "Todo", nextStatusSymbol: "x", availableAsCommand: true, type: "TODO"}],
		["x", {symbol: "x", name: "Done", nextStatusSymbol: " ", availableAsCommand: true, type: "DONE"}],
		["/", {symbol: "/", name: "In progress", nextStatusSymbol: "x", availableAsCommand: true, type: "IN_PROGRESS"}],
		["-", {symbol: "-", name: "Cancelled", nextStatusSymbol: " ", availableAsCommand: true, type: "CANCELLED"}],
	]);

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

function inferStatusType(symbol: string): StatusType {
	if (symbol === "x" || symbol === "X") return "DONE";
	if (symbol === "/") return "IN_PROGRESS";
	if (symbol === "-") return "CANCELLED";
	if (symbol === "") return "EMPTY";
	return "TODO";
}
