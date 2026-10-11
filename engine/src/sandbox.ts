// The forge sandbox (compose service `forge`: the engine's own image with this command, network_mode none, no
// environment, no dstack socket, the shared /work volume): runs the gates' forge and anvil jobs the engine writes there
// (src/limited.ts), one at a time, and writes each result back.
import { SANDBOX, serveJobs } from "./limited.ts";

// This container runs as uid 1001 in the engine's group (1000), and the two share the work volume: everything the
// sandbox (and forge in it) creates there is the group's to read, write and remove, so the engine can clean up.
process.umask(0o007);
await serveJobs(process.argv[2] ?? SANDBOX.dir);
