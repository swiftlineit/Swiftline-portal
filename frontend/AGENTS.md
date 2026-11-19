<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Development Approach

Before writing new code:

1. Check whether the requested feature is actually necessary.
2. Search the existing codebase for reusable components, utilities, and patterns.
3. Prefer built-in browser, framework, and standard-library features.
4. Use dependencies already installed in the project before adding new ones.
5. Avoid introducing new packages unless clearly necessary.
6. Make the smallest safe change that solves the request.
7. Do not refactor unrelated code.
8. Do not create abstractions for one-time usage.
9. Preserve existing architecture, naming conventions, and UI patterns.
10. Verify the result before considering the task complete.