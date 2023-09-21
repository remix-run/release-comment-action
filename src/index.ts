import * as core from "@actions/core";

import { main } from "./lib.js";

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    core.setFailed(`Action failed with error ${error}`);
  },
);
