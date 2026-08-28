/**
 * The first-run screen.
 *
 * Two properties are worth more than the rest. The minted key is shown exactly
 * once and cannot be recovered, so anything that hides it before the operator
 * has copied it loses a credential. And a field the environment owns must be
 * visibly locked rather than quietly ignored — accepting a value the
 * deployment overrides is the failure the precedence rule exists to prevent.
 */
import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let statusResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let submitResolver: (body: unknown, init: unknown) => Promise<unknown> = () =>
  Promise.resolve({ data: null, error: null });
const submitted: Array<{ body: unknown; init: unknown }> = [];

void mock.module("../lib/api", () => ({
  client: () => ({}),
  anonymous: () => ({
    setup: Object.assign(
      {
        post: (body: unknown, init: unknown) => {
          submitted.push({ body, init });
          return submitResolver(body, init);
        },
      },
      { status: { get: () => statusResolver() } },
    ),
  }),
}));

const { SetupPage } = await import("../pages/SetupPage");
const { useSetup } = await import("../store/setup");

const STATUS = (over: Record<string, unknown> = {}) => ({
  data: {
    configured: false,
    canMintKey: true,
    apiKeySource: "none",
    settings: {
      instanceName: { value: "bunwa", source: "default" },
      serverTimezone: { value: "Asia/Jakarta", source: "default" },
    },
    ...over,
  },
  error: null,
});

beforeEach(() => {
  submitted.length = 0;
  useSetup.setState({
    configured: null,
    canMintKey: false,
    apiKeySource: "none",
    settings: null,
    busy: false,
    error: null,
    mintedKey: null,
  });
  statusResolver = () => Promise.resolve(STATUS());
  submitResolver = () =>
    Promise.resolve({
      data: {
        settings: {
          instanceName: { value: "grande", source: "database" },
          serverTimezone: { value: "Asia/Jakarta", source: "database" },
        },
        apiKey: "bw_live_default_secret",
        apiKeySource: "database",
      },
      error: null,
    });
});

afterEach(cleanup);

describe("before the server has answered", () => {
  test("shows neither the form nor a verdict", async () => {
    // Rendering the form would be a guess, and guessing wrong shows a setup
    // screen to an instance that is already configured.
    statusResolver = () => new Promise(() => undefined);
    render(<SetupPage />);
    expect(screen.queryByLabelText("Instance name")).toBeNull();
  });
});

describe("the instance name", () => {
  test("previews what WhatsApp will actually display", async () => {
    // The whole point: someone typing "Grande POS" learns here that the phone
    // shows "Grande-POS", not after pairing a device and wondering why.
    render(<SetupPage />);
    const input = await screen.findByLabelText("Instance name");

    fireEvent.change(input, { target: { value: "Grande POS" } });

    expect(await screen.findByText(/Google Chrome \(Grande-POS\)/)).toBeDefined();
  });

  test("warns that pairing by code ignores it", async () => {
    // Otherwise an operator pairs by code, sees "Ubuntu", and reports a bug.
    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Instance name"), { target: { value: "grande" } });

    expect(await screen.findByText(/Ubuntu/)).toBeDefined();
  });
});

describe("a setting the environment owns", () => {
  test("is locked rather than quietly ignored", async () => {
    statusResolver = () =>
      Promise.resolve(
        STATUS({
          settings: {
            instanceName: { value: "bunwa", source: "default" },
            serverTimezone: { value: "UTC", source: "environment" },
          },
        }),
      );

    render(<SetupPage />);
    const field = (await screen.findByLabelText("Server timezone")) as HTMLInputElement;

    expect(field.disabled).toBe(true);
    expect(await screen.findByText(/SERVER_TIMEZONE/)).toBeDefined();
  });

  test("is not sent, so the server has nothing to reject", async () => {
    statusResolver = () =>
      Promise.resolve(
        STATUS({
          settings: {
            instanceName: { value: "bunwa", source: "default" },
            serverTimezone: { value: "UTC", source: "environment" },
          },
        }),
      );

    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect((submitted[0]?.body as { serverTimezone?: string }).serverTimezone).toBeUndefined();
  });
});

describe("the minted key", () => {
  test("replaces the form, so nothing competes with it", async () => {
    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    expect(await screen.findByText("bw_live_default_secret")).toBeDefined();
    expect(screen.queryByLabelText("Setup token"), "the form is gone").toBeNull();
  });

  test("says plainly that it will not be shown again", async () => {
    // Without this an operator closes the tab and has locked themselves out of
    // an instance they just created.
    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    expect(await screen.findByText(/only time it will be shown/i)).toBeDefined();
  });

  test("stays until it is dismissed deliberately", async () => {
    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    await screen.findByText("bw_live_default_secret");

    // A re-render for any reason must not clear it.
    cleanup();
    render(<SetupPage />);
    expect(screen.getByText("bw_live_default_secret")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
    expect(screen.queryByText("bw_live_default_secret")).toBeNull();
  });

  test("the token is carried in the header, not the body", async () => {
    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: " tok " } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    const init = submitted[0]?.init as { headers: Record<string, string> };
    expect(init.headers["x-setup-token"], "and trimmed, because it was pasted").toBe("tok");
    expect(submitted[0]?.body).not.toHaveProperty("token");
  });
});

describe("when the server refuses", () => {
  test("says so and keeps the form", async () => {
    submitResolver = () => Promise.resolve({ data: null, error: { status: 401, value: null } });

    render(<SetupPage />);
    fireEvent.change(await screen.findByLabelText("Setup token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByLabelText("Setup token"), "so it can be corrected").toBeDefined();
  });
});
