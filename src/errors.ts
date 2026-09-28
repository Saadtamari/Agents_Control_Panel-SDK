export type AgentStatus = "idle" | "running" | "paused" | "stopped";

/**
 * Thrown by wrapAgentRun when the agent is paused or stopped.
 * Callers can catch this to skip work without treating it as an LLM failure.
 */
export class AgentPausedError extends Error {
  readonly status: AgentStatus;

  constructor(status: AgentStatus) {
    super(`Agent is ${status}; skipping execution`);
    this.name = "AgentPausedError";
    this.status = status;
  }
}
