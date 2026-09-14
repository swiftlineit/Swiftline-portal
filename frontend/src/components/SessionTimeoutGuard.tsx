"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAccessToken, logout, refreshAccessToken, setSessionEndedReason } from "@/lib/auth";
import { useDialog } from "@/lib/useDialog";
import {
  IDLE_SIGN_OUT_MESSAGE,
  SESSION_IDLE_COUNTDOWN_MS,
  SESSION_IDLE_WARNING_AFTER_MS
} from "@/lib/sessionTimeout";
import { saveUnsavedWork } from "@/lib/useUnsavedChanges";

/**
 * Signs out a portal that has been left unattended.
 *
 * After fifteen minutes without activity the user is asked whether they are still
 * there, and has one minute to answer before being signed out and returned to
 * the login page. Answering restarts the fifteen minutes.
 *
 * This is the visible half of a rule the server already enforces
 * (`SESSION_IDLE_TIMEOUT_MINUTES` in userSession.service.ts). The server decides
 * whether a token still works; this decides what the person sees, and gives them
 * the warning a bare 401 never could. It ends the session for real rather than
 * only clearing the screen- `logout()` revokes it server-side, so walking away
 * from an unlocked machine does not leave a usable session behind.
 */

/**
 * Shared across tabs.
 *
 * Without this, a second tab left open in the background would reach its own
 * idle limit and sign the user out of the tab they were actively working in-
 * the session is server-side, so one tab giving up ends it everywhere.
 */
const ACTIVITY_KEY = "swiftline:last-activity";
const SIGNED_OUT_KEY = "swiftline:idle-signed-out";

/** Written at most this often; the limit is minutes, so a to-the-second value buys nothing. */
const ACTIVITY_WRITE_INTERVAL_MS = 5_000;

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "wheel", "keydown", "scroll", "touchstart"] as const;

function readSharedActivity() {
  try {
    return Number(window.localStorage.getItem(ACTIVITY_KEY)) || 0;
  } catch {
    // Private-browsing modes can throw on access. Falling back to this tab's own
    // timestamp degrades to single-tab behaviour rather than breaking the guard.
    return 0;
  }
}

function writeShared(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // See above- a tab that cannot share still times out correctly on its own.
  }
}

export default function SessionTimeoutGuard() {
  const router = useRouter();
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(SESSION_IDLE_COUNTDOWN_MS / 1000));

  // Seeded on mount rather than at render: reading the clock while rendering is
  // impure, and a ref initialiser runs on every render even though only the
  // first result is kept.
  const lastActivityRef = useRef(0);
  const lastWriteRef = useRef(0);
  // Read inside listeners that are attached once, where state would be stale.
  const warningRef = useRef(false);
  const warningStartedAtRef = useRef(0);
  const deadlineRef = useRef(0);
  const signingOutRef = useRef(false);

  /** The most recent activity in any tab. */
  const effectiveActivity = useCallback(
    () => Math.max(lastActivityRef.current, readSharedActivity()),
    []
  );

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;

    // Set before awaiting so the login page can explain the bounce even if the
    // logout request is slow or fails.
    setSessionEndedReason(IDLE_SIGN_OUT_MESSAGE);

    // The draft registry already owns the current form's canonical save action.
    // Give it a chance to flush before revoking the session, without allowing a
    // failed network request to defeat the security timeout.
    await saveUnsavedWork();
    writeShared(SIGNED_OUT_KEY, Date.now());
    await logout();
    router.replace("/");
  }, [router]);

  const stayOn = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    lastWriteRef.current = now;
    // Written immediately rather than on the throttle, so any other tab sitting
    // on its own warning dismisses it on the next tick instead of signing out.
    writeShared(ACTIVITY_KEY, now);
    warningRef.current = false;
    warningStartedAtRef.current = 0;
    setWarning(false);

    // Refreshing also touches the server-side idle clock. Without this, a user
    // could answer the visible warning but still hit the server's hard timeout.
    void refreshAccessToken()
      .then((token) => {
        // A transient network/server failure leaves the current token in place.
        // A rejected refresh clears it and requires a fresh sign-in.
        if (token || getAccessToken()) return;
        setSessionEndedReason("Your session has ended. Please sign in again.");
        router.replace("/");
      })
      .catch(() => {
        // Structured session-ended errors already stored their exact reason.
        router.replace("/");
      });
  }, [router]);

  // Activity tracking. Registered once, driven entirely through refs, so moving
  // the mouse never causes a render.
  useEffect(() => {
    // Arriving on the page is itself activity, and this runs long before the
    // first tick, so the timer never sees an unseeded zero.
    lastActivityRef.current = Date.now();

    function markActive() {
      // While the prompt is up, only the button answers it. Otherwise reaching
      // for the mouse to click "I'm still here" would silently cancel the
      // countdown and the prompt would appear to dismiss itself.
      if (warningRef.current || signingOutRef.current) return;

      const now = Date.now();
      lastActivityRef.current = now;

      if (now - lastWriteRef.current >= ACTIVITY_WRITE_INTERVAL_MS) {
        lastWriteRef.current = now;
        writeShared(ACTIVITY_KEY, now);
      }
    }

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, markActive, { passive: true });
    }

    return () => {
      for (const eventName of ACTIVITY_EVENTS) window.removeEventListener(eventName, markActive);
    };
  }, []);

  // Another tab signing out takes this one with it: the server session is gone,
  // so staying on a dashboard would only produce failing requests.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== SIGNED_OUT_KEY || !event.newValue || signingOutRef.current) return;

      signingOutRef.current = true;
      setSessionEndedReason(IDLE_SIGN_OUT_MESSAGE);
      router.replace("/");
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [router]);

  /**
   * One timer for both phases, comparing timestamps rather than counting down.
   *
   * A counter that decremented per tick would be wrong after a laptop sleeps or
   * the tab is backgrounded and throttled: the browser stops firing intervals,
   * and the session would appear to survive hours of absence. Reading the clock
   * each tick means a machine that wakes after the deadline signs out at once.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (signingOutRef.current) return;

      const lastActivity = effectiveActivity();
      // Belt and braces: never treat an unseeded timestamp as idle.
      if (!lastActivity) return;

      const now = Date.now();

      if (!warningRef.current) {
        if (now - lastActivity >= SESSION_IDLE_WARNING_AFTER_MS) {
          warningRef.current = true;
          warningStartedAtRef.current = now;
          deadlineRef.current = now + SESSION_IDLE_COUNTDOWN_MS;
          setSecondsLeft(Math.round(SESSION_IDLE_COUNTDOWN_MS / 1000));
          setWarning(true);
        }
        return;
      }

      // Activity in another tab answers the question on this one's behalf.
      if (lastActivity > warningStartedAtRef.current) {
        warningRef.current = false;
        warningStartedAtRef.current = 0;
        setWarning(false);
        return;
      }

      const remaining = deadlineRef.current - now;
      if (remaining <= 0) {
        void signOut();
        return;
      }

      setSecondsLeft(Math.ceil(remaining / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [effectiveActivity, signOut]);

  if (!warning) return null;

  return <IdleWarningDialog secondsLeft={secondsLeft} onStay={stayOn} onSignOut={() => void signOut()} />;
}

function IdleWarningDialog({
  secondsLeft,
  onStay,
  onSignOut
}: {
  secondsLeft: number;
  onStay: () => void;
  onSignOut: () => void;
}) {
  // Escape keeps the session: pressing a key is proof someone is there, and the
  // destructive reading of "dismiss" would be a strange thing to do by default.
  const dialogRef = useDialog<HTMLDivElement>(true, onStay);
  const remainingFraction = Math.max(0, Math.min(1, secondsLeft / (SESSION_IDLE_COUNTDOWN_MS / 1000)));

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-[#0D1282]/30 px-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-description"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
      >
        <div className="rounded-t-2xl border-b border-slate-100 bg-[#EEEDED]/50 px-5 py-4">
          <h2 id="idle-warning-title" className="text-lg font-bold text-[#0D1282]">Are you still there?</h2>
        </div>

        <div className="px-5 py-4">
          <p id="idle-warning-description" className="text-sm leading-6 text-slate-600">
            You have been inactive for 15 minutes. For your security you will be signed out in one
            minute unless you continue.
          </p>

          <div className="mt-4 flex items-center gap-3">
            {/* Aria-hidden: announcing a number every second would talk over
                everything else. The sentence above already gives the deadline. */}
            <span
              aria-hidden="true"
              className="text-2xl font-bold tabular-nums text-[#0D1282]"
            >
              {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
                  secondsLeft <= 10 ? "bg-[#D71313]" : "bg-[#0D1282]"
                }`}
                style={{ width: `${remainingFraction * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Reversed: "Continue session" comes first in the DOM so the dialog's
            opening focus lands on it and Enter keeps the session, while
            row-reverse still renders it on the right where the primary action
            belongs. Focusing "Sign out now" would make the safe key press the
            destructive one. */}
        <div className="flex flex-row-reverse flex-wrap justify-start gap-3 rounded-b-2xl border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onStay}
            className="rounded-lg bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63]"
          >
            Continue session
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282]"
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}
