import { Loader } from "@cloudflare/kumo";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

interface Health {
	plugin: string;
	version: string;
	siteUrl: string | null;
}

function GraphPage() {
	const [health, setHealth] = React.useState<Health>();
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		apiFetch("/_emdash/api/plugins/sitegraph/health")
			.then((res) => parseApiResponse<Health>(res, "Could not reach SiteGraph"))
			.then(setHealth)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, []);

	return (
		<section className="space-y-4">
			<h1 className="text-2xl font-semibold">SiteGraph</h1>
			{health ? (
				<p>
					v{health.version} · site URL: {health.siteUrl ?? "not set"}
				</p>
			) : error ? (
				<p role="alert">{error}</p>
			) : (
				<Loader />
			)}
		</section>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": GraphPage,
};
