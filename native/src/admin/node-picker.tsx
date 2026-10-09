import * as React from "react";

import { api, isBroken, type Node, TYPE_LABEL } from "./api.js";

/** Debounced search over graph nodes. Used to pick a relationship target. */
export function useNodeSearch(query: string, opts: { type?: Node["type"]; broken?: boolean } = {}) {
	const [state, setState] = React.useState<{ items: Node[]; loading: boolean; error?: string }>({ items: [], loading: false });
	const { type, broken } = opts;
	React.useEffect(() => {
		let live = true;
		setState((s) => ({ ...s, loading: true }));
		const timer = setTimeout(() => {
			api
				.search(query.trim(), { type, broken })
				.then((r) => live && setState({ items: r.items, loading: false }))
				.catch((e: unknown) => live && setState({ items: [], loading: false, error: e instanceof Error ? e.message : String(e) }));
		}, 200);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [query, type, broken]);
	return state;
}

export function NodePicker({ value, onChange, exclude }: { value: Node | null; onChange: (node: Node | null) => void; exclude?: string }) {
	const [query, setQuery] = React.useState("");
	const { items, loading } = useNodeSearch(query);
	const options = items.filter((n) => n.id !== exclude).slice(0, 8);
	const id = React.useId();

	if (value) {
		return (
			<div className="sg-picked">
				<span>
					<span className="sg-kind" data-type={value.type}>
						{TYPE_LABEL[value.type]}
					</span>{" "}
					{value.label}
				</span>
				<button type="button" className="sg-link" onClick={() => onChange(null)}>
					Change
				</button>
			</div>
		);
	}

	return (
		<div className="sg-field">
			<label htmlFor={id}>
				<span>Target</span>
			</label>
			<input id={id} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing a name or path" autoComplete="off" />
			<ul className="sg-options" role="listbox" aria-busy={loading}>
				{options.map((n) => (
					<li key={n.id}>
						<button type="button" onClick={() => onChange(n)}>
							<span className="sg-kind" data-type={n.type}>
								{isBroken(n) ? "Broken link" : TYPE_LABEL[n.type]}
							</span>{" "}
							{n.label}
						</button>
					</li>
				))}
				{!loading && options.length === 0 ? <li className="sg-muted">No matches. Names match from their first letter.</li> : null}
			</ul>
		</div>
	);
}
