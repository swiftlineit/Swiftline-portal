"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, useState } from "react";
import { requestPasswordReset } from "@/lib/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const result = await requestPasswordReset(email);
      setMessage(result.message);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to send reset link.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-blue-900 px-4 py-8">
      <section className="w-full max-w-md border border-gray-200 rounded-2xl bg-white px-8 py-10 shadow-lg">
        <div className="mb-8 text-center">
          <Image
            src="/slclogo1.png"
            alt="Swiftline Cargo"
            width={64}
            height={64}
            className="mx-auto  h-20 w-25 rounded"
            priority
          />
          <h1 className="text-2xl font-semibold text-gray-900">
            Forgot Password
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Enter your login email and we will send a secure reset link.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
           
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder=" example@user.com"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 block w-full border rounded-lg border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
            />
          </div>

          {message ? (
            <p className="text-sm font-medium text-emerald-700">{message}</p>
          ) : null}
          {error ? (
            <p className="text-sm font-medium text-red-600">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-900 px-4 rounded-2xl py-3 text-sm font-semibold text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-blue-900/70"
          >
            {loading ? "Sending..." : "Send Reset Link"}
          </button>
        </form>

        <Link
          href="/"
          className="mt-6 block text-center text-sm font-medium text-sky-700 hover:underline"
        >
          Back to Sign In
        </Link>
      </section>
    </main>
  );
}
