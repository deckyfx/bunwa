/**
 * The labelled input, and revealing a masked one.
 *
 * The reveal toggle is here because of a real failure, not a preference. The
 * API key field is restored from browser storage, so it arrives already filled
 * with a credential nobody just typed. With no way to see it, a key left over
 * from a replaced database looks exactly like the right one — the form appears
 * complete, connecting fails, and the only way to find out is to clear the
 * field and start again.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Field } from "../components/Field";

afterEach(cleanup);

const password = (value = "bw_live_default_secret") =>
  render(<Field id="k" label="API key" type="password" value={value} onChange={() => undefined} />);

describe("a masked field", () => {
  test("starts hidden", () => {
    // The common case is a credential on a screen someone else can see.
    password();
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
  });

  test("can be revealed", () => {
    password();
    fireEvent.click(screen.getByRole("button", { name: "show API key" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("text");
  });

  test("can be hidden again", () => {
    password();
    fireEvent.click(screen.getByRole("button", { name: "show API key" }));
    fireEvent.click(screen.getByRole("button", { name: "hide API key" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
  });

  test("the control says what pressing it does, not what the state is", () => {
    // "hidden" alone does not tell a screen reader user whether pressing
    // changes that.
    password();
    const toggle = screen.getByRole("button", { name: "show API key" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "hide API key" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("revealing shows the value, not a copy of it", () => {
    // Guards the toggle being cosmetic — swapping the type without the value
    // reaching the DOM would pass every assertion above.
    password("bw_live_default_visible");
    fireEvent.click(screen.getByRole("button", { name: "show API key" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("bw_live_default_visible");
  });

  test("a revealed key is rendered in mono", () => {
    // It is about to be compared character by character against another
    // string; 0 and O have to differ.
    password();
    fireEvent.click(screen.getByRole("button", { name: "show API key" }));
    expect(screen.getByLabelText("API key").className).toContain("font-mono");
  });
});

describe("an unmasked field", () => {
  test("has no toggle to press", () => {
    render(<Field id="n" label="Instance name" value="grande" onChange={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a locked field", () => {
  test("is disabled and says why", () => {
    render(
      <Field id="z" label="Server timezone" value="UTC" onChange={() => undefined} disabled hint="set by env" />,
    );
    expect((screen.getByLabelText("Server timezone") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("set by env")).toBeDefined();
  });

  test("the hint is announced with the input rather than merely near it", () => {
    render(<Field id="z" label="Server timezone" value="UTC" onChange={() => undefined} hint="why" />);
    const described = screen.getByLabelText("Server timezone").getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described ?? "")?.textContent).toBe("why");
  });
});
