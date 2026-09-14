"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

export const unsavedChangesMessage = "You have unsaved changes. Leave this page?";

/** What the leave prompt offers to do with the work in progress. */
export type LeaveDecision = "saveDraft" | "discard" | "stay";

type DirtyForm = {
  /** Names the work in the prompt, e.g. "business account". */
  label: string;
  /**
   * Persists the in-progress work as a draft. Absent when the form has no draft
   * state to save, which is what makes the prompt drop its Save-as-draft option
   * rather than offering an action that cannot work.
   */
  saveDraft?: () => Promise<void>;
};

/**
 * Which forms currently hold unsaved edits.
 *
 * Deliberately module state rather than React context. The guard is read by the
 * sidebar and written by whichever form happens to be open, and those two sit in
 * different parts of the tree; with a context provider, any mismatch in where
 * the provider is mounted makes the guard silently pass instead of prompting.
 * There is exactly one instance of this module, so a plain Map cannot get out of
 * sync with itself.
 *
 * Safe under SSR because entries are only ever added from an effect, which does
 * not run on the server.
 */
const dirtyForms = new Map<string, DirtyForm>();

// Subscribers are the mounted leave dialogs, which re-read the store whenever a
// form registers or clears so their offered actions stay accurate.
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Exposed for the confirm dialog and for tests; prefer `useConfirmLeave`. */
export function hasUnsavedWork() {
  return dirtyForms.size > 0;
}

/** The dirty form the prompt should describe. Only one form is open at a time. */
export function getDirtyForm(): DirtyForm | null {
  for (const form of dirtyForms.values()) return form;
  return null;
}

/**
 * Best-effort persistence used immediately before an automatic security logout.
 * Failure never cancels that logout; the caller decides how to proceed.
 */
export async function saveUnsavedWork() {
  const form = getDirtyForm();
  if (!form?.saveDraft) return true;

  try {
    await form.saveDraft();
    return true;
  } catch {
    return false;
  }
}

/**
 * Declares that a form currently holds unsaved edits.
 *
 * Covers the browser's own unload (tab close, reload, external navigation) and
 * registers the form so in-app navigation is guarded too. Passing `saveDraft`
 * adds a "Save as draft" action to the leave prompt; omit it for forms with no
 * draft state.
 */
export function useUnsavedChanges(
  hasUnsavedChanges: boolean,
  options: { label?: string; saveDraft?: () => Promise<void> } = {}
) {
  // Stable across renders, unique per component instance, and safe to read
  // while rendering- unlike a ref.
  const formId = useId();

  // Held in a ref so a new inline `saveDraft` closure on every render does not
  // re-run the registration effect, while the dialog still calls the current
  // one. Declared before that effect so the ref is already fresh when it runs.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!hasUnsavedChanges) {
      // Covers the form being saved: the flag flips to false and the entry must
      // go, or the next navigation prompts about work that is already stored.
      if (dirtyForms.delete(formId)) emit();
      // Tear down browser-back guard when no dirty forms remain.
      if (dirtyForms.size === 0) uninstallBrowserBackGuard();
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      // Browsers show their own wording; assigning returnValue is what actually
      // triggers the prompt. A custom dialog is not possible here, and no async
      // draft save could finish before the page goes away.
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    dirtyForms.set(formId, {
      label: optionsRef.current.label ?? "this form",
      saveDraft: optionsRef.current.saveDraft
        ? () => optionsRef.current.saveDraft!()
        : undefined
    });
    emit();
    installBrowserBackGuard();

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      dirtyForms.delete(formId);
      emit();
      if (dirtyForms.size === 0) uninstallBrowserBackGuard();
    };
    // `options` is read through the ref, so only the dirty flag drives this.
  }, [hasUnsavedChanges, formId]);
}

// ---------------------------------------------------------------------------
// Browser Back / Alt+Left guard
//
// The shared `beforeunload` covers reload and tab close, but a SPA Back via
// `popstate` would otherwise leave silently. This guard intercepts that path
// and funnels it through the same `requestLeave()` dialog so Save Draft is
// available there too.
// ---------------------------------------------------------------------------

let browserGuardActive = false;
let restoringBrowserBack = false;
let browserGuardHandler: ((event: PopStateEvent) => void) | null = null;
let restoreTimeout: number | null = null;
let restoreComplete: ((restored: boolean) => void) | null = null;
let bypassNextBrowserBack = false;

/** Allows the official Back button to replay the popstate it already approved. */
export function allowNextBrowserBack() {
  if (browserGuardActive) bypassNextBrowserBack = true;
}

function installBrowserBackGuard() {
  if (typeof window === "undefined") return;
  if (browserGuardActive) return;
  browserGuardActive = true;

  const handler = () => {
    if (bypassNextBrowserBack) {
      bypassNextBrowserBack = false;
      return;
    }

    // The browser has already moved to the previous history entry. Move
    // forward to the original entry first, preserving Next's own history state
    // instead of manufacturing a raw pushState entry that Next cannot read.
    if (restoringBrowserBack) {
      restoringBrowserBack = false;
      if (restoreTimeout !== null) window.clearTimeout(restoreTimeout);
      restoreTimeout = null;
      restoreComplete?.(true);
      restoreComplete = null;
      return;
    }

    if (!hasUnsavedWork()) {
      uninstallBrowserBackGuard();
      return;
    }

    restoringBrowserBack = true;
    const restored = new Promise<boolean>((resolve) => {
      restoreComplete = resolve;
      restoreTimeout = window.setTimeout(() => {
        // A same-document popstate should always arrive. If a browser does not
        // emit one for the forward operation, do not open a prompt against an
        // unknown URL; the native beforeunload path remains the safe fallback.
        restoringBrowserBack = false;
        restoreTimeout = null;
        restoreComplete = null;
        resolve(false);
      }, 1000);
    });
    window.history.forward();

    void restored.then(async (didRestore) => {
      if (!didRestore || !hasUnsavedWork()) return;
      const canLeave = await requestLeave();
      if (!canLeave) return;

      if (browserGuardHandler) {
        window.removeEventListener("popstate", browserGuardHandler);
      }
      browserGuardActive = false;
      browserGuardHandler = null;
      window.history.back();
    });
  };

  browserGuardHandler = handler;
  window.addEventListener("popstate", handler);
}

function uninstallBrowserBackGuard() {
  if (typeof window === "undefined") return;
  if (!browserGuardActive) return;
  browserGuardActive = false;
  if (browserGuardHandler) {
    window.removeEventListener("popstate", browserGuardHandler);
    browserGuardHandler = null;
  }
  if (restoreTimeout !== null) window.clearTimeout(restoreTimeout);
  restoreTimeout = null;
  restoreComplete = null;
  restoringBrowserBack = false;
  bypassNextBrowserBack = false;
}

/**
 * The pending navigation the leave dialog is asking about.
 *
 * Module state for the same reason the registry is: the dialog is mounted in the
 * shell while the request to leave comes from the sidebar or a form.
 */
let pendingLeave: ((decision: LeaveDecision) => void) | null = null;
const leaveListeners = new Set<() => void>();

function emitLeave() {
  for (const listener of leaveListeners) listener();
}

function subscribeLeave(listener: () => void) {
  leaveListeners.add(listener);
  return () => {
    leaveListeners.delete(listener);
  };
}

/** True while the leave prompt is open. Read by the dialog. */
export function useLeavePrompt() {
  const open = useSyncExternalStore(subscribeLeave, () => pendingLeave !== null, () => false);
  const form = useSyncExternalStore(
    subscribe,
    () => getDirtyForm(),
    () => null
  );

  const resolve = useCallback((decision: LeaveDecision) => {
    const settle = pendingLeave;
    pendingLeave = null;
    emitLeave();
    settle?.(decision);
  }, []);

  return { open, form, resolve };
}

/**
 * Opens the leave prompt and resolves once the user chooses.
 *
 * Returns true when it is safe to leave- either there was nothing unsaved, the
 * work was saved as a draft, or the user chose to discard it.
 */
export function requestLeave(): Promise<boolean> {
  if (!hasUnsavedWork()) return Promise.resolve(true);

  // A second request while the prompt is already open (a double click on a nav
  // link) must not strand the first one unresolved.
  if (pendingLeave) return Promise.resolve(false);

  return new Promise<LeaveDecision>((resolve) => {
    pendingLeave = resolve;
    emitLeave();
  }).then(async (decision) => {
    if (decision === "stay") return false;

    if (decision === "saveDraft") {
      const form = getDirtyForm();
      try {
        await form?.saveDraft?.();
      } catch {
        // The form surfaces its own error. Staying put keeps the work on screen
        // rather than discarding it because the save happened to fail.
        return false;
      }
    }

    return true;
  });
}

/**
 * Guard for in-app navigation. Resolves true when it is safe to leave.
 *
 * Used by the sidebar through `<Link onNavigate>` and before any `router.push`
 * that would abandon a form. Because the answer is asynchronous, callers must
 * always `preventDefault()` first and navigate themselves once it resolves.
 */
export function useConfirmLeave() {
  return useCallback(() => requestLeave(), []);
}

// Standalone variant for a component that already knows its own dirty state and
// is not going through the registry.
export function confirmLeave(hasUnsavedChanges: boolean) {
  return !hasUnsavedChanges || window.confirm(unsavedChangesMessage);
}

/**
 * `onNavigate` handler for a `<Link>` that must not abandon unsaved work.
 *
 * `onNavigate` is synchronous, so a navigation that needs a decision is always
 * cancelled first and re-issued through the router once the user has answered.
 * Nothing happens at all when no form is dirty, which keeps ordinary navigation
 * on Next's own path rather than routing every click through `router.push`.
 */
export function useGuardedNavigate() {
  const router = useRouter();

  return useCallback((href: string) => (event: { preventDefault: () => void }) => {
    if (!hasUnsavedWork()) return;

    event.preventDefault();
    void requestLeave().then((canLeave) => {
      if (canLeave) router.push(href);
    });
  }, [router]);
}
