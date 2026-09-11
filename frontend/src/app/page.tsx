"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import {
  FiAlertCircle,
  FiArrowLeft,
  FiAward,
  FiEdit2,
  FiEye,
  FiEyeOff,
  FiLock,
  FiMail,
  FiShield,
  FiSmartphone,
  FiUserCheck
} from "react-icons/fi";
import { LuSquareMousePointer } from "react-icons/lu";
import { BsHeadset } from "react-icons/bs";
import {
  AuthRequestError,
  loginWithGoogle,
  loginWithPassword,
  requestLoginOtp,
  setAccessToken,
  takeSessionEndedReason,
  verifyLoginOtp
} from "@/lib/auth";
import { LoginBrandPanel } from "@/components/auth/LoginBrandPanel";
import { OTP_LENGTH, OtpCodeInput } from "@/components/auth/OtpCodeInput";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || "";

const SUPPORT_PHONE = "+91 70271 16600";
const SUPPORT_PHONE_HREF = "tel:+917027116600";
const SUPPORT_EMAIL = "Info@swiftlinefreight.com";

/**
 * Mobile sign-in is designed and built but not wired: OTP delivery needs a Jio
 * DLT-registered sender, which is not provisioned yet. Flipping this to `true`
 * is the whole switch- the tab, the country selector and the field are already
 * here, and only the request/verify calls need pointing at the SMS endpoints.
 */
const MOBILE_LOGIN_ENABLED = false;

const TRUST_SIGNALS = [
  { icon: FiShield, label: "Secure", sublabel: "& Encrypted" },
  { icon: FiAward, label: "ISO 27001", sublabel: "Certified" },
  { icon: FiUserCheck, label: "Authorized", sublabel: "Access Only" },
  { icon: FiLock, label: "Data", sublabel: "Protection" }
];

type LoginTab = "mobile" | "email";
type AuthView = "otp-request" | "otp-verify" | "password";

function getSafeInternalDestination(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

/** Same post-login destination rule for the password, code and Google paths. */
function destinationFor(role: string | undefined) {
  const requestedDestination = getSafeInternalDestination(new URLSearchParams(window.location.search).get("next"));
  if (role === "client") return "/client/dashboard";
  if (role === "delivery") return "/driver";
  return requestedDestination || "/dashboard";
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * Format check for the email fields. Only catches structural problems- the
 * authoritative check on whether a domain actually exists happens on the server.
 * `gmail.cos` is syntactically valid, so it passes here and is rejected there.
 */
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function getEmailFormatError(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  return EMAIL_FORMAT.test(email) ? null : "Please enter a valid email address.";
}

function getLoginErrorMessage(caught: unknown) {
  if (caught instanceof AuthRequestError) {
    const captchaError = caught.code === "CAPTCHA_FAILED" || /captcha|security check/i.test(caught.message);
    if (captchaError) {
      if (process.env.NODE_ENV !== "production") {
        return "Local reCAPTCHA is enabled but this development URL is not registered. Set RECAPTCHA_ENABLED=false in backend/.env and restart the API.";
      }
      return "The security check did not complete. Refresh this page and try again. If it keeps happening, turn off a VPN or ad blocker, or contact Swiftline support.";
    }
    if (caught.status === 401) return "The email or password is incorrect.";
    if (caught.status === 423 || caught.status === 429) return caught.message;
    return caught.message;
  }

  return caught instanceof Error
    ? caught.message
    : "We could not sign you in. Check your connection and try again.";
}

export default function Home() {
  const router = useRouter();
  const [tab, setTab] = useState<LoginTab>("email");
  // Password first: it is the cheapest path for us (no email per attempt) and
  // the fastest for a returning user with a saved credential. OTP stays one
  // click away for anyone who wants it.
  const [view, setView] = useState<AuthView>("password");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  // Seeded from the global rather than left to `<Script onLoad>`: next/script
  // caches loaded sources module-wide and returns early- without firing onLoad
  //- on every later mount of the same src, so a client-side return to this page
  // (sign-out, back navigation) left this false and the Google button missing
  // until a hard refresh.
  const [googleReady, setGoogleReady] = useState(
    () => typeof window !== "undefined" && Boolean(window.google?.accounts?.id)
  );
  // Read once, during the initial state, from whatever ended the previous
  // session- so the reason is on screen in the same paint the user lands on.
  // An unexplained bounce back to the login form reads as a bug.
  const [sessionEndedNotice] = useState(() => takeSessionEndedReason());
  // Absolute timestamps rather than remaining seconds, so a backgrounded tab
  // resumes with the correct time left instead of a stalled counter.
  const [codeDeadlines, setCodeDeadlines] = useState<{ expiresAt: number; resendAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const googleButtonRef = useRef<HTMLDivElement>(null);

  const handleGoogleCredential = useCallback(async (credential: string) => {
    setError("");
    setLoading(true);
    try {
      const data = await loginWithGoogle(credential);
      setAccessToken(data.accessToken);
      router.push(destinationFor(data.user?.role));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in with Google.");
      setLoading(false);
    }
  }, [router]);

  // Backstop for the same problem: the script can also finish loading between
  // this mount and an onLoad that never comes (a second <Script> for the same
  // src elsewhere in the tree wins the cache). Polling stops on the first hit.
  useEffect(() => {
    if (googleReady || !GOOGLE_CLIENT_ID) return;

    const poll = window.setInterval(() => {
      if (!window.google?.accounts?.id) return;
      window.clearInterval(poll);
      setGoogleReady(true);
    }, 150);

    return () => window.clearInterval(poll);
  }, [googleReady]);

  // Runs once the Google Identity Services script has loaded and rendered the button.
  useEffect(() => {
    const container = googleButtonRef.current;
    if (!googleReady || !GOOGLE_CLIENT_ID || !container || !window.google) return;

    const identity = window.google.accounts.id;
    identity.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response) => void handleGoogleCredential(response.credential)
    });

    // GIS renders an iframe at a fixed pixel width, so it has to be told one, and
    // 400 is the widest it accepts. Measured from the container rather than the
    // viewport so the button tracks the card, not the window.
    let rendered = 0;
    const render = () => {
      const width = Math.round(Math.min(400, Math.max(200, container.getBoundingClientRect().width || 320)));
      if (width === rendered) return;

      rendered = width;
      container.replaceChildren();
      identity.renderButton(container, {
        theme: "outline",
        size: "large",
        width,
        text: "signin_with",
        shape: "rectangular",
        logo_alignment: "center"
      });
    };

    render();
    // Re-rendered on resize because the iframe cannot reflow on its own; the
    // width check above means a resize that does not change it costs nothing.
    const observer = new ResizeObserver(render);
    observer.observe(container);

    return () => observer.disconnect();
  }, [googleReady, handleGoogleCredential]);

  // Only ticks while a code is outstanding; nothing on this screen animates otherwise.
  useEffect(() => {
    if (view !== "otp-verify" || !codeDeadlines) return;

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view, codeDeadlines]);

  const secondsToResend = codeDeadlines ? Math.max(0, Math.ceil((codeDeadlines.resendAt - now) / 1000)) : 0;
  const secondsToExpiry = codeDeadlines ? Math.max(0, Math.ceil((codeDeadlines.expiresAt - now) / 1000)) : 0;

  async function getRecaptchaToken(): Promise<string | undefined> {
    if (!RECAPTCHA_SITE_KEY || !window.grecaptcha) return undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        window.grecaptcha!.ready(() => {
          window.grecaptcha!.execute(RECAPTCHA_SITE_KEY, { action: "login" }).then(resolve, reject);
        });
      });
    } catch {
      // Fails open to match the backend: a captcha script/network hiccup shouldn't
      // block a legitimate login attempt.
      return undefined;
    }
  }

  const sendCode = async () => {
    setError("");
    const formatError = getEmailFormatError(email);
    if (formatError) {
      setEmailError(formatError);
      return;
    }
    setLoading(true);

    try {
      const recaptchaToken = await getRecaptchaToken();
      const result = await requestLoginOtp({ email: email.trim(), recaptchaToken });
      const issuedAt = Date.now();

      setOtp("");
      setNow(issuedAt);
      setCodeDeadlines({
        expiresAt: issuedAt + result.expiresInSeconds * 1000,
        resendAt: issuedAt + result.resendInSeconds * 1000
      });
      // The server will not confirm whether this address has an account, so this
      // message is deliberately conditional. Saying "code sent" would leak it.
      setNotice(result.message);
      setView("otp-verify");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to send a sign-in code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await sendCode();
  };

  const handleVerifyCode = async (code: string) => {
    setError("");
    setNotice("");
    setLoading(true);

    try {
      const data = await verifyLoginOtp({ email: email.trim(), code });
      setAccessToken(data.accessToken);
      // Deliberately stays in the loading state: the route change is the next
      // thing that happens, and re-enabling the form would flash it first.
      router.push(destinationFor(data.user?.role));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to verify this code. Please try again.");
      setOtp("");
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    const formatError = getEmailFormatError(email);
    if (formatError) {
      setEmailError(formatError);
      return;
    }
    setLoading(true);

    try {
      const recaptchaToken = await getRecaptchaToken();
      const data = await loginWithPassword({
        email: email.trim(),
        password,
        termsAccepted: true,
        recaptchaToken
      });
      setAccessToken(data.accessToken);
      router.push(destinationFor(data.user?.role));
    } catch (caught) {
      setError(getLoginErrorMessage(caught));
      setLoading(false);
    }
  };

  const goToView = (next: AuthView) => {
    setError("");
    setNotice("");
    setView(next);
  };

  return (
    // Mobile remains a natural stacked document. Desktop uses a viewport-locked
    // layout when there is room, and the short-viewport CSS fallback below lets
    // the document scroll without putting a scrollbar inside either card.
    <div className="login-page flex min-h-dvh w-full max-w-full flex-col overflow-x-hidden bg-[#F6F8FC] text-slate-900 lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      {/* Mobile header intentionally shows only the essentials; the richer company
          identity blocks progressively return as horizontal space becomes available. */}
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-350 items-center gap-2.5 px-4 py-2.5 sm:gap-4 sm:px-6 md:px-8 lg:gap-5 lg:py-2">
          <Link href="/" className="shrink-0" aria-label="Swiftline Cargo and Express Logistics">
            <Image
              src="/slclogo1.png"
              alt="Swiftline Cargo"
              width={1009}
              height={454}
              priority
              className="h-11 w-auto object-contain sm:h-14 lg:h-16"
            />
          </Link>

          <div className="hidden h-8 w-px bg-slate-200 lg:block" />
          <div className="mr-4 hidden min-w-0 flex-col gap-0.5 lg:flex xl:mr-10">
            <p className="uppercase text-[#0D1282]">swiftline cargo</p>
            <p className="uppercase text-sm text-red-600">and express logistic pvt. ltd.</p>
          </div>

          <div className="hidden min-w-0 gap-4 xl:flex">
            <div >
              <Image src="/ashokstambha.png" alt="Government Authorized" width={20} height={20} />
            </div>
           <div> <p className="truncate text-[13px] font-bold uppercase tracking-wide text-[#0D1282]">
              Govt. Authorized Courier &amp; Cargo Service Provider
            </p>
            <p className="truncate text-[11.5px] text-slate-500">
              Approved by Delhi Customs (Import &amp; Export)
            </p></div>
          </div>

          <Link
            href={SUPPORT_PHONE_HREF}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 transition hover:bg-slate-50 sm:gap-1.5 sm:px-2 lg:mr-4 xl:mr-10"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg sm:h-10 sm:w-10">
              <BsHeadset  size={25} aria-hidden="true" />
            </span>
            <span className="hidden lg:block">
              <span className="block text-sm font-bold leading-tight text-[#0D1282]">{SUPPORT_PHONE}</span>
              <span className="block text-[11px] text-slate-500">{SUPPORT_EMAIL}</span>
            </span>
          </Link>

          <Link href="https://www.swiftlinefreight.com" target="_blank" className="hidden shrink-0 items-center justify-center gap-2 text-blue-900 sm:flex">
          <LuSquareMousePointer className=" text-2xl text-black"/>
          <span className="hidden xl:inline">swiftlinefreight.com</span>
          </Link>
        </div>
      </header>

      {/* Phones stay stacked; desktop centers one shared-height row so the brand
          panel and sign-in card remain aligned without introducing card scrolling. */}
      <main className="login-page__main mx-auto grid w-full max-w-350 min-w-0 flex-1 grid-cols-1 items-start gap-5 px-4 py-5 sm:gap-7 sm:px-6 sm:py-7 md:px-8 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(390px,430px)] lg:content-center lg:items-stretch lg:gap-10 lg:py-5 xl:grid-cols-[minmax(0,1fr)_minmax(400px,440px)] xl:gap-14">
        <LoginBrandPanel />

<section className="order-1 mx-auto w-full min-w-0 max-w-130 rounded-2xl border border-slate-200/90 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_14px_36px_-16px_rgba(13,18,130,0.2)] sm:p-5 lg:order-2 lg:max-w-none lg:self-stretch lg:p-5">
          <h2 className="text-center text-[20px] font-bold tracking-tight text-slate-950 sm:text-[22px]">Welcome Back!</h2>
          <p className="mt-0.5 text-center text-[12.5px] text-slate-500">Sign in to your SLC Portal</p>

          {/* The mobile tab is omitted completely until the feature is enabled. */}
          {MOBILE_LOGIN_ENABLED ? (
            <div className="mt-4 grid grid-cols-2 border-b border-slate-200" role="tablist" aria-label="Sign-in method">
              <button
                type="button"
                role="tab"
                id="tab-mobile"
                aria-selected={tab === "mobile"}
                aria-controls="panel-signin"
                disabled={!MOBILE_LOGIN_ENABLED}
                onClick={() => setTab("mobile")}
                className={`-mb-px flex min-w-0 items-center justify-center gap-1 border-b-2 pb-2.5 text-[11px] font-semibold transition sm:gap-1.5 sm:text-[13px] ${
                  tab === "mobile"
                    ? "border-[#D81F26] text-[#0D1282]"
                    : "border-transparent text-slate-400 enabled:hover:text-slate-600"
                } disabled:cursor-not-allowed`}
              >
                Login with Mobile
                {!MOBILE_LOGIN_ENABLED ? (
                  <span className="hidden rounded-full bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-slate-500 min-[360px]:inline">
                    Soon
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-email"
                aria-selected={tab === "email"}
                aria-controls="panel-signin"
                onClick={() => setTab("email")}
                className={`-mb-px min-w-0 border-b-2 pb-2.5 text-[11px] font-semibold transition sm:text-[13px] ${
                  tab === "email"
                    ? "border-[#D81F26] text-[#0D1282]"
                    : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
              >
                Login with Email
              </button>
            </div>
          ) : null}

          <div id="panel-signin" role="tabpanel" aria-labelledby={MOBILE_LOGIN_ENABLED ? (tab === "mobile" ? "tab-mobile" : "tab-email") : undefined}>
            {tab === "mobile" ? (
              <div className="mt-3.5">
                <label htmlFor="mobile" className="block text-sm font-medium text-slate-700">
                  Mobile Number
                </label>
                <div className="mt-1.5 flex overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <span className="flex items-center gap-1 border-r border-slate-200 px-3 text-sm font-medium text-slate-400">
                    +91
                  </span>
                  <span className="relative flex-1">
                    <input
                      id="mobile"
                      type="tel"
                      disabled
                      placeholder="Enter your mobile number"
                      className="w-full cursor-not-allowed bg-transparent py-2.5 pl-3 pr-10 text-sm text-slate-400 outline-none placeholder:text-slate-400"
                    />
                    <FiSmartphone
                      size={16}
                      aria-hidden="true"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300"
                    />
                  </span>
                </div>
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-500">
                  <FiAlertCircle size={15} className="mt-px shrink-0 text-slate-400" aria-hidden="true" />
                  <span>
                    Mobile OTP sign-in is coming soon. Use{" "}
                    <button
                      type="button"
                      onClick={() => setTab("email")}
                      className="font-semibold text-[#0D1282] underline underline-offset-2"
                    >
                      Login with Email
                    </button>{" "}
                    in the meantime.
                  </span>
                </p>
              </div>
            ) : null}

            {tab === "email" && view === "otp-request" ? (
              <form onSubmit={handleRequestCode} className="mt-3.5">
                <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                  Email Address
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setEmailError("");
                    }}
                    placeholder="Enter your email address"
                    className={`w-full rounded-xl border bg-white py-2.5 pl-3.5 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-4 focus:ring-[#0D1282]/10 ${
                      emailError
                        ? "border-[#B3121A] focus:border-[#B3121A]"
                        : "border-slate-300 focus:border-[#0D1282]"
                    }`}
                  />
                  <FiMail
                    size={16}
                    aria-hidden="true"
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                </div>
                {emailError ? (
                  <p role="alert" className="mt-1.5 text-[12px] font-medium text-[#B3121A]">
                    {emailError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="mt-3 w-full rounded-xl bg-[#0D1282] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#0a0f6b] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0D1282]/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Sending code…" : "Send OTP"}
                </button>
              </form>
            ) : null}

            {tab === "email" && view === "otp-verify" ? (
              <div className="mt-3.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-slate-600">
                    Enter the {OTP_LENGTH}-digit code sent to
                    <br />
                    <span className="font-semibold text-slate-900">{email.trim()}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setCodeDeadlines(null);
                      setOtp("");
                      goToView("otp-request");
                    }}
                    className="flex shrink-0 items-center gap-1 pt-0.5 text-xs font-semibold text-[#0D1282] hover:underline"
                  >
                    <FiEdit2 size={12} aria-hidden="true" />
                    Change
                  </button>
                </div>

                <div className="mt-3">
                  <OtpCodeInput
                    label="Sign-in code"
                    value={otp}
                    onChange={setOtp}
                    onComplete={handleVerifyCode}
                    disabled={loading}
                    invalid={Boolean(error)}
                  />
                </div>

                <button
                  type="button"
                  disabled={loading || otp.length < OTP_LENGTH}
                  onClick={() => void handleVerifyCode(otp)}
                  className="mt-3 w-full rounded-xl bg-[#0D1282] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#0a0f6b] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0D1282]/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Verifying…" : "Verify & Sign in"}
                </button>

                <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-500">
                    {secondsToExpiry > 0 ? `Code expires in ${formatCountdown(secondsToExpiry)}` : "Code expired"}
                  </span>
                  <button
                    type="button"
                    disabled={loading || secondsToResend > 0}
                    onClick={() => void sendCode()}
                    className="font-semibold text-[#0D1282] transition hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
                  >
                    {secondsToResend > 0 ? `Resend in ${secondsToResend}s` : "Resend code"}
                  </button>
                </div>
              </div>
            ) : null}

            {tab === "email" && view === "password" ? (
              <form onSubmit={handlePasswordSubmit} className="mt-3.5">
                <label htmlFor="password-email" className="block text-sm font-medium text-slate-700">
                  Email Address
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="password-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setEmailError("");
                    }}
                    placeholder="Enter your email address"
                    className={`w-full rounded-xl border bg-white py-2.5 pl-3.5 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-4 focus:ring-[#0D1282]/10 ${
                      emailError
                        ? "border-[#B3121A] focus:border-[#B3121A]"
                        : "border-slate-300 focus:border-[#0D1282]"
                    }`}
                  />
                  <FiMail
                    size={16}
                    aria-hidden="true"
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                </div>
                {emailError ? (
                  <p role="alert" className="mt-1.5 text-[12px] font-medium text-[#B3121A]">
                    {emailError}
                  </p>
                ) : null}

                <div className="mt-3 flex items-center justify-between gap-3">
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                    Password
                  </label>
                  <Link href="/auth/forgot-password" className="text-xs font-semibold text-[#0D1282] hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative mt-1.5">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter your password"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-3.5 pr-10 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:ring-4 focus:ring-[#0D1282]/10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((previous) => !previous)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 outline-none transition hover:text-slate-600 focus-visible:text-[#0D1282]"
                  >
                    {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="mt-3 w-full rounded-xl bg-[#0D1282] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#0a0f6b] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0D1282]/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Signing in…" : "Sign In"}
                </button>
              </form>
            ) : null}
          </div>

          {sessionEndedNotice ? (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11.5px] font-medium leading-relaxed text-amber-800">
              {sessionEndedNotice}
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] font-medium leading-relaxed text-[#B3121A]"
            >
              <FiAlertCircle size={15} className="mt-px shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          {notice && !error ? (
            <p
              role="status"
              className="mt-3 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-600"
            >
              <FiMail size={15} className="mt-px shrink-0 text-slate-400" aria-hidden="true" />
              {notice}
            </p>
          ) : null}

          <div className="my-2.5 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">or</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          {view === "password" ? (
            <button
              type="button"
              onClick={() => goToView("otp-request")}
              className="flex w-full items-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282]/35 hover:bg-slate-50"
            >
              <FiMail size={15} className="text-slate-500" aria-hidden="true" />
              Login with OTP
              <span className="ml-auto text-slate-400" aria-hidden="true">
                →
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setCodeDeadlines(null);
                setOtp("");
                goToView("password");
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282]/35 hover:bg-slate-50"
            >
              <FiArrowLeft size={15} className="text-slate-500" aria-hidden="true" />
              Back to password sign-in
            </button>
          )}

          {/* Kept mounted across every view: the Google button is an iframe that
              would have to be re-rendered from scratch on each remount. */}
          <div className={GOOGLE_CLIENT_ID ? "mt-2 flex w-full min-w-0 justify-center overflow-hidden" : "hidden"} ref={googleButtonRef} />

          <div className="mt-3 border-t border-slate-100 pt-3 text-center">
            <p className="text-xs font-semibold text-slate-600">
              <Link href="/request/business-account" className="inline-flex items-center tracking-wide gap-1 font-bold text-[#0D1282] hover:underline">
                Create business account <FiArrowLeft className="h-3 w-3 rotate-180" aria-hidden="true" />
              </Link>
            </p>
           
          </div>

          <p className="mt-2 text-center text-[10.5px] leading-relaxed text-slate-500">
            By continuing, you agree to Swiftline&apos;s terms and{" "}
            <Link
              href="/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[#0D1282] hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </p>

          {/* <ul className="mt-2.5 grid grid-cols-4 gap-1.5 border-t border-slate-100 pt-2.5">
            {TRUST_SIGNALS.map(({ icon: Icon, label, sublabel }) => (
              <li key={label} className="text-center">
                <Icon size={16} className="mx-auto text-[#0D1282]" aria-hidden="true" />
                <span className="mt-1 block text-[9px] font-medium leading-tight text-slate-500">
                  {label}
                  <br />
                  {sublabel}
                </span>
              </li>
            ))}
          </ul> */}

        </section>
      </main>

      <footer className="shrink-0 bg-[#0D1282] text-white">
        <div className="mx-auto flex w-full max-w-350 flex-col gap-2 px-4 py-2.5 text-center sm:px-6 md:flex-row md:items-center md:justify-between md:px-8 md:text-left">
          <div className="flex items-center justify-center gap-2.5 md:justify-start">
            
            <div>
              <p className="text-[12.5px] font-semibold leading-tight">
                Government Authorized Courier &amp; Cargo Service Provider
              </p>
              <p className="text-[11px] leading-tight text-white/60">
                Approved by Delhi Customs (Import &amp; Export)
              </p>
            </div>
          </div>

          <p className="text-[11px] text-white/60">
            © {new Date().getFullYear()} Swiftline Cargo and Express Logistics Pvt Ltd. All rights reserved.{" "}
            <Link href="/privacy-policy" className="font-medium text-white/85 hover:underline">
              Privacy Policy
            </Link>
          </p>
        </div>
      </footer>

      {GOOGLE_CLIENT_ID ? (
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onLoad={() => setGoogleReady(true)}
        />
      ) : null}
      {RECAPTCHA_SITE_KEY ? (
        <Script
          src={`https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`}
          strategy="afterInteractive"
        />
      ) : null}
    </div>
  );
}
