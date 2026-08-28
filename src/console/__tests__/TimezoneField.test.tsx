/**
 * Choosing a timezone.
 *
 * The field used to be free text, which meant the only feedback for
 * "Asia/Jakata" was a rejected save. What is asserted here is that a typo is
 * visible before submitting, that the list is the runtime's own rather than a
 * hardcoded one that can drift from the server validating it, and that an
 * unlisted-but-valid zone is still accepted — a browser knowing fewer zones
 * than the server must not be able to stop an operator setting one.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TimezoneField } from "../components/TimezoneField";

afterEach(cleanup);

const renderField = (value: string) => {
  const onChange = () => undefined;
  return render(<TimezoneField id="tz" value={value} onChange={onChange} />);
};

describe("the list", () => {
  test("comes from the runtime, not a hardcoded set", () => {
    // Hundreds of zones, and specifically the ones this engine knows — a
    // shipped list would drift from the server that validates against Intl.
    const { container } = renderField("UTC");
    const options = container.querySelectorAll("datalist option");

    expect(options.length).toBeGreaterThan(50);
    expect([...options].some((o) => o.getAttribute("value") === "Asia/Jakarta")).toBe(true);
  });

  test("is attached to the input, so typing narrows it", () => {
    // A select would be unusable at this size; the association is what makes
    // typing "jak" a search rather than a guess.
    const { container } = renderField("UTC");
    const input = screen.getByLabelText("Server timezone");

    expect(input.getAttribute("list")).toBe("tz-zones");
    expect(container.querySelector("datalist")?.id).toBe("tz-zones");
  });
});

describe("feedback while typing", () => {
  test("shows the current time in the chosen zone", () => {
    // The name alone does not answer "will the logs read the way I expect?".
    // Asia/Jakarta and Asia/Bangkok share an offset; a wrong continent shows
    // up immediately in the hour.
    renderField("UTC");
    expect(screen.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)).toBeDefined();
  });

  test("two zones an hour apart do not render the same time", () => {
    // Guards against the preview being cosmetic — a hardcoded or
    // locale-defaulted clock would pass the test above and fail this one.
    const { container: utc } = render(<TimezoneField id="a" value="UTC" onChange={() => undefined} />);
    const { container: jakarta } = render(
      <TimezoneField id="b" value="Asia/Jakarta" onChange={() => undefined} />,
    );

    expect(utc.textContent).not.toBe(jakarta.textContent);
  });

  test("says so when the zone is not one this browser knows", () => {
    // The typo case, caught before the save rather than by it.
    renderField("Asia/Jakata");
    expect(screen.getByText(/not a zone this browser knows/)).toBeDefined();
  });

  test("an empty field is not an error", () => {
    // Nothing typed yet is not the same as something wrong.
    renderField("");
    expect(screen.queryByText(/not a zone/)).toBeNull();
  });

  test("still accepts free text, so an unlisted zone can be set", () => {
    let latest = "";
    render(
      <TimezoneField
        id="tz"
        value=""
        onChange={(next) => {
          latest = next;
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Server timezone"), { target: { value: "Pacific/Kiritimati" } });
    expect(latest).toBe("Pacific/Kiritimati");
  });
});

describe("when the environment owns it", () => {
  test("the field is disabled", () => {
    render(<TimezoneField id="tz" value="UTC" onChange={() => undefined} disabled hint="set by SERVER_TIMEZONE" />);
    expect((screen.getByLabelText("Server timezone") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/set by SERVER_TIMEZONE/)).toBeDefined();
  });
});
