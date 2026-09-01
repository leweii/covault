/**
 * Long-running commands, and the callback that wakes the agent when one
 * of them ends.
 *
 * The alternative is what this exists to kill. A foreground command can
 * only run as long as the tool's own timeout, so the model's instinct —
 * `sleep 90; cat the.log` — is killed mid-sleep and returns nothing; it
 * then tries again, and one poll costs one model turn, so a ten-minute
 * pipeline burns the entire turn budget without producing a single
 * useful thought. Here the command is detached from the tool call, the
 * turn ends immediately, and the process exiting is what brings the
 * conversation back to life.
 *
 * Jobs belong to one conversation: the registry is created alongside the
 * Ask engine that starts them and stopped with it, so no pipeline
 * outlives the chat that was going to report on it.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setTimeout as setNodeTimeout } from "node:timers";

export interface BackgroundJob {
  /** Short handle the model uses to refer to the job ("bg1"). */
  id: string;
  command: string;
  /** Where stdout and stderr are being collected, interleaved. */
  logPath: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "exited" | "failed";
  /** Exit code once it has one; null when a signal ended it. */
  exitCode: number | null;
  /** The signal that ended it, including our own SIGTERM from stop(). */
  signal: string | null;
  /** Set when the process could not be started at all. */
  startError?: string;
}

export interface BackgroundJobsDeps {
  cwd: () => string;
  /** The user's real login-shell environment; see cliInventory.ts. */
  env?: () => Record<string, string | undefined>;
  /** Where log files are written. Defaults to the OS temp directory. */
  logDir?: () => string;
}

/** How much of a log the model is handed at once, in bytes from the end.
 *  Enough for a stack trace or a summary block; the full log stays on
 *  disk and the model is told the path. */
export const TAIL_BYTES = 4_000;

/** A conversation cannot have more than this many commands in flight.
 *  One approved command that starts jobs in a loop is a fork bomb with
 *  extra steps; this is the ceiling that makes that boring. */
const MAX_RUNNING = 8;

/** Grace between asking a process group to stop and insisting. */
const KILL_GRACE_MS = 2_000;

export class BackgroundJobs {
  private jobs = new Map<string, BackgroundJob>();
  private pids = new Map<string, number>();
  private listeners = new Set<(job: BackgroundJob) => void>();
  private seq = 0;

  constructor(private deps: BackgroundJobsDeps) {}

  /** Called every time a job ends — the wake-up. Returns an unsubscribe. */
  onFinished(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  running(): BackgroundJob[] {
    return this.list().filter((job) => job.status === "running");
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Start a command in its own process group and return at once.
   *
   * `detached` is the load-bearing flag: the shell becomes a group
   * leader, so stop() can take the whole tree down with it. Without it a
   * killed shell leaves the pipeline it launched running with nobody
   * holding the other end — which is exactly how a "timed out" command
   * kept writing to its log while the model was told it had failed.
   */
  start(command: string): BackgroundJob {
    if (this.running().length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} background commands are already running — wait for one to finish or stop it first.`);
    }
    const id = `bg${++this.seq}`;
    const dir = this.deps.logDir?.() ?? os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `covault-${id}-${Date.now()}.log`);
    const job: BackgroundJob = {
      id,
      command,
      logPath,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      signal: null,
    };
    this.jobs.set(id, job);

    // The log file is the only channel: stdio goes straight to the fd, so
    // output survives even the parts of it we never read, and the process
    // is not held up by anyone draining a pipe.
    const fd = fs.openSync(logPath, "a");
    try {
      const child = spawn(command, {
        cwd: this.deps.cwd(),
        env: this.deps.env?.(),
        shell: true,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.on("error", (error) => {
        job.startError = error.message;
        this.finish(job, "failed", null, null);
      });
      child.on("exit", (code, signal) => {
        this.finish(job, code === 0 ? "exited" : "failed", code, signal);
      });
      if (child.pid !== undefined) this.pids.set(id, child.pid);
    } finally {
      // The child holds its own duplicate of the descriptor; ours would
      // otherwise leak one fd per job for the life of the conversation.
      fs.closeSync(fd);
    }
    return job;
  }

  /** The tail of a job's output, as the model should see it. */
  tail(id: string, maxBytes = TAIL_BYTES): string {
    const job = this.jobs.get(id);
    if (!job) return "";
    return tailFile(job.logPath, maxBytes);
  }

  /**
   * Stop a job's whole process group. SIGTERM first — a pipeline that
   * traps it gets to clean up — then SIGKILL for whatever ignored it.
   */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    const pid = this.pids.get(id);
    if (!job || job.status !== "running" || pid === undefined) return false;
    killGroup(pid, "SIGTERM");
    // A Node timer, like the process it is grace period for, and unreffed
    // so a job stopped at shutdown does not keep anything alive waiting.
    setNodeTimeout(() => {
      if (this.jobs.get(id)?.status === "running") killGroup(pid, "SIGKILL");
    }, KILL_GRACE_MS).unref?.();
    return true;
  }

  /**
   * Stop everything still running — the conversation moved on.
   *
   * A detached job would otherwise outlive Obsidian itself, still writing
   * to a log no one will ever read. Killing is the honest end: nothing is
   * left running that has no way to report back.
   */
  stopAll(): void {
    for (const job of this.running()) this.stop(job.id);
  }

  /** Stop everything and stop listening — the registry is finished with. */
  dispose(): void {
    this.stopAll();
    this.listeners.clear();
  }

  private finish(job: BackgroundJob, status: BackgroundJob["status"], code: number | null, signal: string | null): void {
    if (job.status !== "running") return; // exit and error can both fire
    job.status = status;
    job.exitCode = code;
    job.signal = signal;
    job.endedAt = Date.now();
    this.pids.delete(job.id);
    for (const listener of [...this.listeners]) listener(job);
  }
}

/** Read at most the last `maxBytes` of a file, without loading the rest. */
export function tailFile(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return "";
    const from = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - from);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, buffer.length, from);
    const text = buffer.toString("utf8");
    return from > 0 ? `…(earlier output in ${file})\n${text}` : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** How a finished job reads in a status line or a log. */
export function describeJob(job: BackgroundJob): string {
  const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const took = seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
  if (job.status === "running") return `${job.id} running for ${took}`;
  if (job.startError) return `${job.id} could not start after ${took}: ${job.startError}`;
  if (job.signal) return `${job.id} killed by ${job.signal} after ${took}`;
  return `${job.id} finished with exit code ${job.exitCode ?? "?"} after ${took}`;
}

/** Signal a whole process group, tolerating one that is already gone. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}
