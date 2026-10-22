/** `express4` is `npm:express@^4` (package.json devDependencies), so both majors run side by
 * side. Express 4 ships no types; the API the tests use is the one @types/express describes. */
declare module "express4" {
  import express from "express";
  export default express;
}
