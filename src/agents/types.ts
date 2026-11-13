import type { Q } from '../db.ts';
import type { ExecResult, Why } from '../kernel.ts';
import type { Policies, Role } from '../model.ts';

/** One event delivered to a role's own inbox. */
export type Task = { seq: number; kind: string; subject: string; payload: any; created_at: number };

/** What a role runtime hands its policy for one turn. The policy can read shared records and execute commands
 *  as its own role; it cannot write records directly and cannot act as another role. */
export interface Turn {
  readonly role: Role;
  readonly company: string;
  readonly clock: number;
  readonly policies: Policies;
  /** This role's private belief state; persisted at the end of the turn. */
  mem: any;
  readonly tasks: Task[];
  exec(cmd: string, params: Record<string, unknown>, why: Why, causation?: number): Promise<ExecResult>;
  done(task: Task): Promise<void>;
  read<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  /** A fault-injection point: an injected crash fires here, after earlier commands have committed. */
  checkpoint(label: string): void;
  plan(text: string): void;
}
export type Policy = (t: Turn) => Promise<void>;
