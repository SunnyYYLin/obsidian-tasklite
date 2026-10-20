/**
 * A per-key Promise mutex that ensures operations on the same key (e.g. vault file path)
 * are executed sequentially, preventing read-modify-write race conditions.
 */
export class KeyedMutex {
	private readonly queues = new Map<string, Promise<void>>();

	async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(key) ?? Promise.resolve();
		let resolveNext!: () => void;
		const current = new Promise<void>((r) => {
			resolveNext = r;
		});

		// Chain after previous operation regardless of success or failure
		this.queues.set(
			key,
			prev.then(
				() => current,
				() => current,
			),
		);

		try {
			await prev;
			return await fn();
		} finally {
			resolveNext();
			if (this.queues.get(key) === current) {
				this.queues.delete(key);
			}
		}
	}
}
