// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Coordinator dispatch rules. This is the only way work reaches a browser now,
// so every way it can silently stall is worth a regression test:
//
//  1. dispatching to a socket that is not OPEN — the row is claimed but never
//     runs, so it sits until the reclaim sweep.
//  2. losing capacity accounting — a browser that never acks, or acks twice,
//     either starves itself or is handed more than it can run.
//  3. missing a dispatch trigger — an agent joining an existing backlog, a
//     freed slot, a raised budget. Anything that can make a queued row
//     assignable has to re-run dispatch or the row waits indefinitely.
//  4. holding rows an agent can no longer run, after it disconnects.
//
// The Durable Object needs a workerd runtime, so rather than boot one we
// exercise the same selection and accounting logic against the module's own
// source contract plus a faithful local model.

import fs from "node:fs";
import path from "node:path";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface Agent { caps: string[]; maxConcurrent: number; holding: string[]; open: boolean }

// Mirrors WorkCoordinator.dispatch's selection: only OPEN sockets, only ones
// with spare capacity, only ones whose caps satisfy the row.
function pick(agents: Agent[], required: string[]): Agent | undefined {
  return agents.find((a) =>
    a.open && a.holding.length < a.maxConcurrent && required.every((c) => a.caps.includes(c)));
}

function main(): void {
  console.log("agent selection:");
  {
    const closed: Agent = { caps: ["ffmpeg"], maxConcurrent: 4, holding: [], open: false };
    const open: Agent = { caps: ["ffmpeg"], maxConcurrent: 4, holding: [], open: true };
    assert(pick([closed], ["ffmpeg"]) === undefined,
      "a closed socket is never chosen, even with full capacity");
    assert(pick([closed, open], ["ffmpeg"]) === open,
      "a closed socket is skipped in favour of an open one");

    const full: Agent = { caps: ["ffmpeg"], maxConcurrent: 2, holding: ["a", "b"], open: true };
    assert(pick([full], ["ffmpeg"]) === undefined,
      "an agent at its ceiling is not given more work");

    const noFfmpeg: Agent = { caps: ["music-metadata"], maxConcurrent: 4, holding: [], open: true };
    assert(pick([noFfmpeg], ["ffmpeg"]) === undefined,
      "an agent missing a required cap is not chosen");
    assert(pick([noFfmpeg], []) === noFfmpeg,
      "a row with no required caps goes to any open agent");
    assert(pick([], ["ffmpeg"]) === undefined,
      "an empty pool yields nothing rather than holding the row");
  }

  console.log("\ncapacity accounting:");
  {
    // The 'done' handler drops by id, so a duplicate ack is a no-op instead of
    // manufacturing capacity the browser does not have.
    const release = (holding: string[], id: string) => holding.filter((h) => h !== id);
    assert(release(["a", "b"], "a").length === 1, "one completion frees one slot");
    assert(release(["a"], "a").length === 0, "the last completion returns to idle");
    assert(release([], "a").length === 0, "an ack for nothing held is harmless");
    assert(release(["a", "b"], "b").join() === "a", "the right slot is freed, not just the last");
    assert(release(release(["a"], "a"), "a").length === 0,
      "a duplicate ack cannot free a slot twice");
    assert(release(["a", "b"], "a").join() === "b",
      "an unstarted task can release its slot without a completion ack");
  }

  console.log("\nsource contract:");
  {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../worker/src/coordinator/workCoordinator.ts"),
      "utf-8",
    );
    assert(src.includes("READY_STATE_OPEN"),
      "dispatch filters sockets on readyState");
    assert(src.includes("webSocketClose"),
      "close handler present so dead agents leave the pool");
    // Two independent places return a row to 'queued' without burning the
    // attempt: a send that throws mid-dispatch, and an agent disconnecting.
    assert((src.match(/attempts = MAX\(0, attempts - 1\)/g) || []).length >= 2,
      "both the failed-send and the disconnect paths un-burn the attempt");
    assert(src.includes("setWebSocketAutoResponse"),
      "keepalive is answered without waking a hibernating object");
    assert(src.includes("serializeAttachment"),
      "agent state lives in the socket attachment so it survives hibernation");

    // Every edge that can make a queued row assignable must re-run dispatch.
    // Missing one is a silent stall now that nothing polls.
    const joinBody = src.slice(src.indexOf("private async join("), src.indexOf("async webSocketMessage("));
    assert(/await this\.dispatch\(\)/.test(joinBody),
      "join dispatches, so an agent joining an existing backlog gets work");
    assert(/status: 101/.test(joinBody.slice(joinBody.indexOf("await this.dispatch()"))),
      "join awaits dispatch BEFORE returning the 101, not as detached I/O");
    const msgBody = src.slice(src.indexOf("async webSocketMessage("), src.indexOf("async webSocketClose("));
    assert((msgBody.match(/await this\.dispatch\(\)/g) || []).length >= 2,
      "both a freed slot and a config change re-run dispatch");
    assert(src.includes("releaseHeld"),
      "a disconnect releases the rows that agent was holding");
    assert(src.includes('case "release"'),
      "an unstarted task is returned to queued instead of acknowledged as done");
    assert(/worker_pool_enabled[\s\S]{0,120}return \{ dispatched: 0/.test(src),
      "dispatch re-reads the kill switch, so an admin can stop a connected fleet");
  }

  console.log("\nthe queue has no puller left:");
  {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../worker/src/endpoints/edgesonic/work.ts"),
      "utf-8",
    );
    assert(/async function wakePool[\s\S]{0,300}try \{[\s\S]{0,200}catch/.test(src),
      "coordinator notify is wrapped so a dead coordinator cannot fail an enqueue");
    assert(!src.includes('workRoutes.get("/work/poll"'),
      "the poll route is gone");
    assert(/dispatchWork\(\s*\n?\s*db: D1Database,\s*\n?\s*input: DispatchInput,\s*\n?\s*env: Env/.test(src),
      "dispatchWork requires env, so the compiler catches a dispatch that never wakes anyone");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
