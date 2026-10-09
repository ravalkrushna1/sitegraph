import "./sitegraph.css";

import { Loader } from "@cloudflare/kumo";
import type { PluginAdminExports } from "emdash";
import * as React from "react";

import { api, message, type Overview } from "./api.js";
import { Explorer } from "./explorer.js";

function OverviewWidget() {
	const [overview, setOverview] = React.useState<Overview>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		api.overview().then(setOverview, (e: unknown) => setError(message(e)));
	}, []);

	if (error) return <p role="alert">{error}</p>;
	if (!overview) return <Loader />;
	if (!overview.scan.last) {
		return (
			<p className="sg-widget">
				Your site hasn't been mapped yet. <a href="/_emdash/admin/plugins/sitegraph/">Run the first scan</a>
			</p>
		);
	}
	return (
		<div className="sg-widget">
			<p>
				{overview.counts.CONTENT} entries mapped,{" "}
				<a href="/_emdash/admin/plugins/sitegraph/" data-alert={overview.brokenLinks > 0 || undefined}>
					{overview.brokenLinks === 0
						? "no broken internal links"
						: `${overview.brokenLinks} broken internal link${overview.brokenLinks === 1 ? "" : "s"}`}
				</a>
				.
			</p>
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": Explorer,
};

export const widgets: PluginAdminExports["widgets"] = {
	overview: OverviewWidget,
};
