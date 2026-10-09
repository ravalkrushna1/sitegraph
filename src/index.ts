import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

const ID = "sitegraph";
const VERSION = "0.1.0";
const PACKAGE = "emdash-plugin-sitegraph";
const ADMIN_ENTRY = `${PACKAGE}/admin`;

const PAGES = [{ path: "/", label: "SiteGraph", icon: "graph" }];

/** Build-time descriptor: register with `emdash({ plugins: [siteGraph()] })`. */
export function siteGraph(): PluginDescriptor {
	return {
		id: ID,
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: ADMIN_ENTRY,
		adminPages: PAGES,
	};
}

/** Runtime entry. EmDash imports this by name. */
export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: ID,
		version: VERSION,
		capabilities: ["content:read", "schema:read"],
		admin: { entry: ADMIN_ENTRY, pages: PAGES },
		routes: {
			health: {
				permission: "plugins:read",
				handler: async (ctx) => ({
					plugin: ID,
					version: VERSION,
					siteUrl: ctx.site.url || null,
				}),
			},
		},
	});
}

export default siteGraph;
