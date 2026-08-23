/**
 * What a rule is.
 *
 * gowa's entire automation surface is one global static string — reply this to
 * everyone, on every device (docs/01). This is the replacement, and the shape
 * comes straight from the brief: a message from a certain number, to a certain
 * number, containing a certain format, triggers something.
 */
import { compilePattern, type CompiledPattern } from "./pattern";
import { ValidationError } from "../stores/errors";

/** Comparisons a condition can make. */
export const OPERATORS = [
  "eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with",
  "matches", "exists", "gt", "gte", "lt", "lte",
] as const;

export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  /** Dotted path into the event: `data.from`, `device.jid`, `type`. */
  field: string;
  op: Operator;
  value?: unknown;
}

/** Conditions combine; `all` is the common case and the default. */
export interface Match {
  all?: Condition[];
  any?: Condition[];
  none?: Condition[];
}

export type Action =
  | { type: "reply"; template: string }
  | { type: "forward"; url: string; include?: Array<"match" | "event"> }
  | { type: "tag"; value: string }
  | { type: "suppress" }
  | { type: "noop" };

export interface RuleDefinition {
  name: string;
  enabled: boolean;
  /** Lower runs first. */
  priority: number;
  stopOnMatch: boolean;
  match: Match;
  actions: Action[];
}

/** A rule with its patterns already compiled, ready to evaluate. */
export interface PreparedRule extends RuleDefinition {
  compiled: Map<string, CompiledPattern>;
}

const MAX_CONDITIONS = 20;
const MAX_ACTIONS = 10;

/**
 * Validate a rule and compile its patterns.
 *
 * Everything expensive or refusable happens here, at save time, with a human
 * watching — never on the inbound path where the only options are to drop a
 * customer's message or to hang.
 *
 * @throws ValidationError
 */
export function prepareRule(definition: RuleDefinition): PreparedRule {
  if (definition.name.trim() === "") throw new ValidationError("rule name is required", "name");

  const groups = [definition.match.all, definition.match.any, definition.match.none].filter(
    (g): g is Condition[] => g !== undefined,
  );
  if (groups.length === 0) {
    // A rule with no conditions matches every message, which is never what
    // anyone means and is an expensive way to find out.
    throw new ValidationError("a rule must have at least one condition", "match");
  }

  const total = groups.reduce((n, g) => n + g.length, 0);
  if (total > MAX_CONDITIONS) {
    throw new ValidationError(`a rule may have at most ${MAX_CONDITIONS} conditions`, "match");
  }
  if (definition.actions.length === 0) throw new ValidationError("a rule must have at least one action", "actions");
  if (definition.actions.length > MAX_ACTIONS) {
    throw new ValidationError(`a rule may have at most ${MAX_ACTIONS} actions`, "actions");
  }

  const compiled = new Map<string, CompiledPattern>();
  for (const group of groups) {
    for (const condition of group) {
      if (!(OPERATORS as readonly string[]).includes(condition.op)) {
        throw new ValidationError(`unknown operator "${condition.op}"`, "match");
      }
      if (condition.field.trim() === "") throw new ValidationError("condition field is required", "match");
      if (condition.op === "matches") {
        if (typeof condition.value !== "string") {
          throw new ValidationError(`"matches" needs a pattern string`, "match");
        }
        compiled.set(`${condition.field}:${condition.value}`, compilePattern(condition.value, "match"));
      }
    }
  }

  for (const action of definition.actions) {
    if (action.type === "reply" && action.template.trim() === "") {
      throw new ValidationError("a reply action needs a template", "actions");
    }
    if (action.type === "forward" && action.url.trim() === "") {
      throw new ValidationError("a forward action needs a url", "actions");
    }
  }

  return { ...definition, compiled };
}
