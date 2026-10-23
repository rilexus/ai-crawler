# Where to add files

## All new files

Write new files as ES modules (`import` and `export`). `package.json` sets
`"type": "module"`, so Node loads every `.js` file as an ES module.

## Features

Keep a feature's backend and frontend together in one folder:

- `<feature>/server/`: its Express API server.
- `<feature>/web/`: its React UI.

`workflow/` is the current example.

## Shared code

- **Class or module used by entry points:** Create `lib/<name>.js`.
  Default-export its main class, for example `export default Workflow`.
  Keep entry points such as `index.js` limited to setup and calls.

## Workflow apps

- **App that runs workflows:** Create workflows with `new Workflow({ id })`
  from `lib/workflow.js` and mount `workflow.serve()` in the app's Express
  server, for example at `/api/workflow`. Don't configure the app's own URL:
  the workflow server syncs with it by calling PUT on that path. Add the
  path's full URL to `WORKFLOW_APP_URLS` on the workflow server.
- **Workflow callback:** `create()` registers a workflow template and calls
  the callback once without running any step, to find its step labels. Each
  `step()` returns undefined there, so keep code outside steps free of side
  effects.
- **Runs:** Each `run()` or matching event starts a new run with its own
  event and step state, so runs of one workflow can overlap. Keep per-run
  state in the run object, never in the template. A retry resumes a failed
  run under the same ID, with finished step results that the workflow server
  sends, so the app doesn't keep runs after they end.
- **App behind a proxy or in a container:** If the URL the sync request
  reaches isn't the one the workflow server should call, set `serveHost` and
  `servePath` on `serve()`, or `WORKFLOW_SERVE_HOST` and `WORKFLOW_SERVE_PATH`
  in the app's environment.

## API

- **Route for an existing resource:** Add it to that resource's router in
  `<feature>/server/routers/<resource>/index.js`.
- **New resource:** Create `<feature>/server/routers/<resource>/index.js`
  that default-exports an Express `Router()`. Mount it in
  `<feature>/server/routers/api/index.js` with
  `api.use("/<resource>", router)`, before the JSON 404 handler. Write route
  paths relative to the mount point.
- **Data for the UI:** Don't add REST routes for the UI. The UI talks to its
  server over the WebSocket at `/ws` in `<feature>/server/socket.js`. Add a
  message type there (a JSON object with a `type` field), and send it on
  connect and after the data changes. REST routes are for writes from other
  processes, such as `lib/workflow.js`.
- **Database access:** Add an exported function to `<feature>/server/db.js`.
  Routers call `db.*` functions and never write SQL themselves.

## React UI

- **Component:** Create a folder `<feature>/web/components/<Name>/` with these
  files:
  - `<Name>.jsx`, which default-exports the component. Put hooks that only
    this component uses in this file or in its folder.
  - `styles.ts`, with the component's styled-components as named exports.
  - `index.js`, containing `export { default } from "./<Name>";`, so you can
    import the component as `./components/<Name>`.
- **Entry point:** Keep `<feature>/web/index.jsx` limited to the root render,
  so Fast Refresh works.
- **Global styles and colors:** Put page-wide styles in
  `<feature>/web/global-styles.ts` as a `createGlobalStyle` named
  `GlobalStyle`, rendered once in `App.jsx`. Define colors there as CSS
  custom properties named by role (`--color-error`, not `--color-red`), with
  light and dark values. Component styles use `var(--color-…)`, never literal
  colors.

## Browser automation

- **Flow:** Add it under `flows/<site>/`, using `defineFlow` from
  `lib/flow.js`.
