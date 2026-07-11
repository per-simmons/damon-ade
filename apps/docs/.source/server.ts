// @ts-nocheck
import * as __fd_glob_18 from "../content/docs/workspaces.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/using-monorepos.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/use-with-ide.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/terminal-presets.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/terminal-integration.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/setup-teardown-scripts.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/ports.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/overview.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/mcp.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/keyboard-shortcuts.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/installation.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/first-workspace.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/faq.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/diff-viewer.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/customization.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/custom-themes.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/browser.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/agent-integration.mdx?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, }, {"agent-integration.mdx": __fd_glob_1, "browser.mdx": __fd_glob_2, "custom-themes.mdx": __fd_glob_3, "customization.mdx": __fd_glob_4, "diff-viewer.mdx": __fd_glob_5, "faq.mdx": __fd_glob_6, "first-workspace.mdx": __fd_glob_7, "installation.mdx": __fd_glob_8, "keyboard-shortcuts.mdx": __fd_glob_9, "mcp.mdx": __fd_glob_10, "overview.mdx": __fd_glob_11, "ports.mdx": __fd_glob_12, "setup-teardown-scripts.mdx": __fd_glob_13, "terminal-integration.mdx": __fd_glob_14, "terminal-presets.mdx": __fd_glob_15, "use-with-ide.mdx": __fd_glob_16, "using-monorepos.mdx": __fd_glob_17, "workspaces.mdx": __fd_glob_18, });