# @gbd/core

Domain-neutral values and helpers shared by every TypeScript package. Zero runtime
dependencies, by design.

## Just-in-time package

`exports` points directly at TypeScript source (`./src/index.ts`) rather than at a
compiled `dist/`. Consumers' bundlers compile it, so there is no build step and no
build ordering to get wrong.

That only works because this package has **no runtime dependencies**, and it is the
reason for the rule below.

> **Rule for `packages/*`:** a package may export TypeScript source only if it has zero
> runtime `dependencies`. Anything with runtime dependencies gets a real build step and
> exports a compiled `dist/`.

The reason is `@sveltejs/adapter-node`. It marks everything in `apps/web`'s
`dependencies` as external and bundles the rest. A source-exporting package with its
own runtime deps would be inlined into the bundle while its dependencies were resolved
from `apps/web/`, where pnpm's strict layout means they do not exist — a
`Could not resolve "..."` build failure. A compiled package with declared dependencies
does not have that problem.
