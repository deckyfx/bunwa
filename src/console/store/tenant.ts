/**
 * Blanking a store when the credential behind it changes.
 *
 * The session store clears its own `identity` on a key change and nothing else
 * did, so the singleton stores kept whatever the previous key had loaded.
 * Between accepting key B and B's own requests landing, the screens rendered —
 * with key A's devices, claims, deliveries, conversations, drafts and errors on
 * them. One tenant's data under another tenant's credential, which is the thing
 * this whole product exists to make impossible.
 *
 * The dependency points this way round on purpose. Every tenant store already
 * imports the session; having the session import them back to reset them would
 * be a cycle, and a registry the stores opt into would silently do nothing for
 * a store nobody had imported yet.
 */
import { useSession } from "./session";

/**
 * Reset `store` to `blank` whenever the API key changes.
 *
 * Called once per store, at module scope, so the subscription lives as long as
 * the store does — there is nothing to unsubscribe, because a singleton that
 * outlives every component has no teardown to hang it on.
 *
 * Fires on any change of key, including to the empty string: signing out has
 * to clear tenant data for the same reason switching does.
 */
export function blankOnKeyChange<T>(
  store: { setState: (partial: Partial<T>) => void },
  blank: () => Partial<T>,
): void {
  useSession.subscribe((state, previous) => {
    if (state.apiKey === previous.apiKey) return;
    store.setState(blank());
  });
}
