/**
 * The rule engine.
 *
 * gowa's automation is one global static string. This is the replacement, so
 * the tests are about the two things that make it usable rather than
 * dangerous: it must not be a denial-of-service vector, and it must not talk
 * to itself.
 */
import { describe, expect, test } from "bun:test";

import { compilePattern, runMatch, MAX_PATTERN_LENGTH, MAX_SUBJECT_LENGTH } from "../pattern";
import { prepareRule, type RuleDefinition } from "../schema";
import { evaluate, MAX_CHAIN_DEPTH } from "../evaluate";
import { ValidationError } from "../../stores/errors";

const baseRule = (overrides: Partial<RuleDefinition> = {}): RuleDefinition => ({
  name: "test",
  enabled: true,
  priority: 10,
  stopOnMatch: false,
  match: { all: [{ field: "type", op: "eq", value: "message.received" }] },
  actions: [{ type: "noop" }],
  ...overrides,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "message.received",
  device: { jid: "628999@s.whatsapp.net" },
  data: { from: "628123@s.whatsapp.net", text: "PAY AB1234", chat_type: "direct" },
  ...overrides,
});

describe("pattern safety", () => {
  test("refuses the constructs that backtrack", () => {
    // RE2 has none of these, and they are exactly what makes matching
    // super-linear. A tenant pattern runs against every inbound message.
    for (const [source, reason] of [
      ["(?=foo)", "lookahead"],
      ["(?!foo)", "negative lookahead"],
      ["(?<=foo)", "lookbehind"],
      ["(a)\\1", "backreference"],
    ] as const) {
      expect(() => compilePattern(source)).toThrow(new RegExp(reason));
    }
  });

  test("refuses nested quantifiers", () => {
    // (a+)+ against a long non-matching string is the classic catastrophic case.
    expect(() => compilePattern("(a+)+$")).toThrow(/exponential/);
    expect(() => compilePattern("(ab*)*c")).toThrow(/exponential/);
  });

  test("refuses an over-long pattern", () => {
    expect(() => compilePattern("a".repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/at most/);
  });

  test("refuses an invalid pattern with the reason attached", () => {
    expect(() => compilePattern("([unclosed")).toThrow(ValidationError);
  });

  test("accepts an ordinary pattern and returns named captures", () => {
    const compiled = compilePattern("^PAY\\s+(?<ref>[A-Z0-9]{6,})$");
    const result = runMatch(compiled, "PAY AB1234");
    expect(result.matched).toBe(true);
    expect(result.captures["ref"]).toBe("AB1234");
  });

  test("is not stateful across calls", () => {
    // A global flag would carry lastIndex between messages and make a rule
    // match intermittently — close to impossible to debug from outside.
    const compiled = compilePattern("PAY");
    expect(runMatch(compiled, "PAY").matched).toBe(true);
    expect(runMatch(compiled, "PAY").matched).toBe(true);
  });
});

describe("rule validation", () => {
  test("refuses a rule with no conditions", () => {
    // It would match every message, which nobody means and which is expensive
    // to discover.
    expect(() => prepareRule(baseRule({ match: {} }))).toThrow(/at least one condition/);
  });

  test("refuses a rule with no actions", () => {
    expect(() => prepareRule(baseRule({ actions: [] }))).toThrow(/at least one action/);
  });

  test("refuses an unknown operator", () => {
    expect(() =>
      prepareRule(baseRule({ match: { all: [{ field: "x", op: "wat" as never }] } })),
    ).toThrow(/unknown operator/);
  });

  test("compiles patterns at save time, not on the inbound path", () => {
    // The only options on the inbound path are to drop a customer's message or
    // to hang, so an unsafe pattern must be refused while a human is watching.
    expect(() =>
      prepareRule(baseRule({ match: { all: [{ field: "data.text", op: "matches", value: "(a+)+" }] } })),
    ).toThrow(/exponential/);
  });
});

describe("evaluation", () => {
  test("matches the brief's example: sender, recipient and format", () => {
    const rule = prepareRule(
      baseRule({
        name: "payments",
        match: {
          all: [
            { field: "type", op: "eq", value: "message.received" },
            { field: "data.from", op: "in", value: ["628123@s.whatsapp.net"] },
            { field: "device.jid", op: "eq", value: "628999@s.whatsapp.net" },
            { field: "data.text", op: "matches", value: "^PAY\\s+(?<ref>[A-Z0-9]{6,})$" },
          ],
        },
        actions: [{ type: "reply", template: "Received {{ match.ref }}" }],
      }),
    );

    const result = evaluate({ event: event(), rules: [rule] });
    expect(result.matched).toEqual(["payments"]);
    expect(result.actions[0]!.captures["ref"]).toBe("AB1234");
  });

  test("runs rules in priority order and honours stopOnMatch", () => {
    const first = prepareRule(baseRule({ name: "first", priority: 1, stopOnMatch: true }));
    const second = prepareRule(baseRule({ name: "second", priority: 2 }));
    expect(evaluate({ event: event(), rules: [second, first] }).matched).toEqual(["first"]);
  });

  test("skips disabled rules", () => {
    const rule = prepareRule(baseRule({ enabled: false }));
    expect(evaluate({ event: event(), rules: [rule] }).matched).toHaveLength(0);
  });

  test("a non-matching condition stops the rule", () => {
    const rule = prepareRule(
      baseRule({ match: { all: [{ field: "data.from", op: "eq", value: "someone-else" }] } }),
    );
    expect(evaluate({ event: event(), rules: [rule] }).matched).toHaveLength(0);
  });

  test("a dotted path cannot reach the prototype chain", () => {
    const rule = prepareRule(
      baseRule({ match: { all: [{ field: "constructor.prototype", op: "exists" }] } }),
    );
    expect(evaluate({ event: event(), rules: [rule] }).matched).toHaveLength(0);
  });
});

describe("loop protection", () => {
  test("an event bunwa caused is not evaluated at all", () => {
    // A reply is a message. Without this, a rule that answers a message answers
    // its own answer for ever.
    const rule = prepareRule(baseRule());
    const result = evaluate({ event: event(), rules: [rule], selfOriginated: true });
    expect(result.skipped).toBe("self_originated");
    expect(result.actions).toHaveLength(0);
  });

  test("a chain is cut at the depth cap even if origin marking was lost", () => {
    // Belt and braces: origin marking can be lost across an engine boundary.
    const rule = prepareRule(baseRule());
    const result = evaluate({ event: event(), rules: [rule], chainDepth: MAX_CHAIN_DEPTH });
    expect(result.skipped).toBe("chain_depth");
  });

  test("a normal event at depth zero is evaluated", () => {
    const rule = prepareRule(baseRule());
    expect(evaluate({ event: event(), rules: [rule], chainDepth: 0 }).matched).toEqual(["test"]);
  });
});

describe("case handling", () => {
  test("substring operators fold case; matches does not", () => {
    // A regex author controls case with flags and character classes. Folding
    // the subject would silently defeat [A-Z] and every similar construct —
    // and did, until a test written from the brief's own example failed.
    const contains = prepareRule(
      baseRule({ name: "contains", match: { all: [{ field: "data.text", op: "contains", value: "pay" }] } }),
    );
    expect(evaluate({ event: event(), rules: [contains] }).matched).toEqual(["contains"]);

    const cased = prepareRule(
      baseRule({ name: "cased", match: { all: [{ field: "data.text", op: "matches", value: "^PAY" }] } }),
    );
    expect(evaluate({ event: event(), rules: [cased] }).matched).toEqual(["cased"]);

    const wrongCase = prepareRule(
      baseRule({ name: "wrong", match: { all: [{ field: "data.text", op: "matches", value: "^pay" }] } }),
    );
    expect(evaluate({ event: event(), rules: [wrongCase] }).matched).toHaveLength(0);
  });
});

describe("findings the group-count check missed", () => {
  test("an empty condition array is not a rule with conditions", () => {
    // `{ match: { all: [] } }` produced one group with no conditions, so a
    // group-count check passed — and [].every(...) is true, so the rule then
    // matched every event and fired. The check reached the outcome it existed
    // to prevent.
    for (const match of [{ all: [] }, { any: [] }, { none: [] }, { all: [], any: [] }]) {
      expect(() => prepareRule(baseRule({ match }))).toThrow(/at least one condition/);
    }
  });

  test("a quantified alternation is refused", () => {
    // (a|aa)+ is the classic overlapping-branch blowup and compiles fine.
    // Deciding whether branches genuinely overlap needs real analysis, so any
    // quantified alternation is refused — conservative on purpose.
    for (const source of ["(a|aa)+$", "(x|xy)*", "(foo|foobar){2,}"]) {
      expect(() => compilePattern(source)).toThrow(/exponential|nests/);
    }
  });

  test("an unquantified alternation is still fine", () => {
    // The refusal must be specific, or every ordinary pattern breaks.
    expect(() => compilePattern("^(foo|bar)$")).not.toThrow();
    expect(() => compilePattern("(?:PAY|SEND) [A-Z]+")).not.toThrow();
  });

  test("the subject is bounded, so a long message cannot amplify a match", () => {
    const compiled = compilePattern("x+$");
    // Truncated rather than rejected: a long message should not silently stop
    // matching, and no realistic rule looks past a few kilobytes.
    const result = runMatch(compiled, "y".repeat(MAX_SUBJECT_LENGTH + 500) + "x");
    expect(result.timedOut).toBe(false);
  });
});
