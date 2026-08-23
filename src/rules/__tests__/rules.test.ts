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

  test("a quantified alternation is refused when its branches can overlap", () => {
    // The hazard is one branch consuming a prefix of what another consumes,
    // which leaves the engine a choice to backtrack over.
    for (const source of ["(a|aa)+$", "(x|xy)*", "(foo|foobar){2,}"]) {
      expect(() => compilePattern(source)).toThrow(/exponential|nests/);
    }
  });

  test("a quantified alternation of disjoint literals is allowed", () => {
    // Refusing these too was the first version, and it rejected a pattern
    // straight out of this project's brief. POST and PUT share a first letter
    // and still cannot both match — they diverge at the second.
    for (const source of ["(?:PAY|SEND)+", "(?:GET|POST|PUT)+", "(foo|bar)+", "(?:a|b|c)+"]) {
      expect(() => compilePattern(source)).not.toThrow();
    }
  });

  test("a branch that is not a plain literal is still refused", () => {
    // Anything with a metacharacter cannot be compared as text, so it is
    // treated as able to overlap.
    expect(() => compilePattern("(a|[bc])+")).toThrow(/exponential|nests/);
    expect(() => compilePattern("(a|b+)+")).toThrow(/exponential|nests/);
  });

  test("an unquantified alternation is still fine", () => {
    // The refusal must be specific, or every ordinary pattern breaks.
    expect(() => compilePattern("^(foo|bar)$")).not.toThrow();
    expect(() => compilePattern("(?:PAY|SEND) [A-Z]+")).not.toThrow();
  });

  test("the subject is bounded, so a long message cannot amplify a match", () => {
    const compiled = compilePattern("needle");

    // Inside the bound: found. Beyond it: not, because the subject was cut.
    // The previous version asserted only `timedOut`, which is false either
    // way — it passed whether or not truncation happened at all.
    const within = "y".repeat(MAX_SUBJECT_LENGTH - 10) + "needle";
    const beyond = "y".repeat(MAX_SUBJECT_LENGTH + 10) + "needle";
    expect(runMatch(compiled, within).matched).toBe(true);
    expect(runMatch(compiled, beyond).matched).toBe(false);
  });
});

describe("a rule that keeps timing out is disabled, not just logged", () => {
  test("evaluate reports the rule id, which is what can address a row", () => {
    // Asserting that prepareRule preserves the id proved nothing about
    // evaluate, which is the function that has to report it — a regression
    // dropping rule.id there would have passed. Second time I have written a
    // test whose name promised more than its assertion.
    const rule = prepareRule(
      baseRule({ name: "slow", match: { all: [{ field: "data.text", op: "matches", value: "^x" }] } }),
      "rule-123",
    );
    // Force the budget to be exceeded so the timeout path actually runs.
    const result = evaluate({ event: event(), rules: [rule], matchTimeoutMs: 0 });
    expect(result.timedOut).toEqual(["rule-123"]);
    expect(result.matched).toHaveLength(0);
  });
});

describe("group syntax is not repetition", () => {
  test("non-capturing and named groups are accepted when quantified", () => {
    // Counting the `?` in a group prefix rejected these, all of them ordinary.
    // A safety check that refuses common patterns is one that gets removed.
    for (const source of ["(?:foo)+", "(?:(?:ab))+", "(?<year>\\d{4})+", "(?:PAY|SEND)+"]) {
      expect(() => compilePattern(source)).not.toThrow();
    }
  });

  test("a fixed count inside a quantified group is safe; a range is not", () => {
    // (\d{4})+ consumes exactly four every time, so it cannot blow up.
    // (\d{1,4})+ can split the same input many ways, which is the whole hazard.
    expect(() => compilePattern("(\\d{4})+")).not.toThrow();
    expect(() => compilePattern("(\\d{1,4})+")).toThrow(/exponential|nests/);
  });

  test("the dangerous shapes are still refused", () => {
    for (const source of ["(a?)+", "(x?){1,}", "(?:a+)+", "(a+)+", "(a|aa)+"]) {
      expect(() => compilePattern(source)).toThrow(/exponential|nests/);
    }
  });
});

describe("nesting must not hide an overlapping alternation", () => {
  test("an extra pair of parentheses is not a way past the check", () => {
    // ((a|aa))+ is exactly as catastrophic as (a|aa)+, and the inner group put
    // the `|` out of view of a top-level scan. Nesting is the cheapest
    // possible evasion, so the analysis follows it to any depth.
    for (const source of ["((a|aa))+$", "(?:(a|aa)){2,}$", "(((x|xy)))+"]) {
      expect(() => compilePattern(source)).toThrow(/exponential|nests/);
    }
  });

  test("nesting a disjoint alternation is still fine", () => {
    // The recursion must not turn into a blanket refusal of nested groups.
    expect(() => compilePattern("((?:PAY|SEND))+")).not.toThrow();
    expect(() => compilePattern("(?:(GET|POST))+")).not.toThrow();
  });
});
