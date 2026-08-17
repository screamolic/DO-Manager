import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import App from "./App";
import { OverviewPage } from "./routes/index.lazy";
import { ServersPage } from "./routes/servers.lazy";
import { ServerDetailPage } from "./routes/servers.$id.lazy";
import { AccountsPage } from "./routes/accounts.lazy";
import { TokensPage } from "./routes/tokens.lazy";
import { JobsPage } from "./routes/jobs.lazy";
import { AuditPage } from "./routes/audit.lazy";

const rootRoute = createRootRoute({
  component: App,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const serversRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/servers",
  component: ServersPage,
});

const serverDetailRoute = createRoute({
  getParentRoute: () => serversRoute,
  path: "$id",
  component: ServerDetailPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounts",
  component: AccountsPage,
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tokens",
  component: TokensPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: JobsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: AuditPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  serversRoute.addChildren([serverDetailRoute]),
  accountsRoute,
  tokensRoute,
  jobsRoute,
  auditRoute,
]);

const router = createRouter({ routeTree });

export { router };

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
