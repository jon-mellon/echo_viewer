import { EchoAgentSession } from "./session.mjs";
import { clonePublication } from "./local_data.mjs";
import { createEchoTools as createTools } from "../site/echo_tools.mjs";
import { CHECK_TOOL_NOTE } from "./diagnostic_checks.mjs";
export function createEchoTools(options) {
  return createTools({ ...options, Session: EchoAgentSession, clone: clonePublication, checkToolNote: CHECK_TOOL_NOTE });
}
