// Vite's `?worker` suffix: the default export constructs the bundled worker.
// (vite/client types are not loaded in this project, so this is declared here.)
declare module '*?worker' {
  const WorkerConstructor: new (options?: { name?: string }) => Worker
  export default WorkerConstructor
}
