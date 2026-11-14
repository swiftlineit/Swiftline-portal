import type { Metadata } from "next";
import { AE, CA, EU, GB, IN, US } from "country-flag-icons/react/3x2";
import { FiGlobe, FiMail, FiPhone } from "react-icons/fi";
import { TERMS_AND_CONDITIONS_TEXT } from "./termsAndConditionsContent";

const countryFlags = { AE, CA, EU, GB, IN, US };
type CountryFlagCode = keyof typeof countryFlags;

function getCountryFlagCode(flag: string): CountryFlagCode | null {
  const regionalIndicators = Array.from(flag, (character) => character.codePointAt(0));
  if (regionalIndicators.length !== 2) return null;
  const [first, second] = regionalIndicators;
  if (
    first === undefined ||
    second === undefined ||
    first < 0x1f1e6 ||
    first > 0x1f1ff ||
    second < 0x1f1e6 ||
    second > 0x1f1ff
  ) {
    return null;
  }

  const code = String.fromCharCode(first - 0x1f1e6 + 65, second - 0x1f1e6 + 65);
  return code in countryFlags ? (code as CountryFlagCode) : null;
}

function getCountryEntries(paragraph: string) {
  const entries = paragraph.split(" • ");
  if (entries.length < 2) return null;

  const countries: { label: string; Flag: (typeof countryFlags)[CountryFlagCode] }[] = [];
  for (const entry of entries) {
    const match = entry.match(/^(\S+)\s+(.+)$/u);
    const code = match ? getCountryFlagCode(match[1]) : null;
    if (!match || !code) return null;
    countries.push({ label: match[2], Flag: countryFlags[code] });
  }

  return countries;
}

type TermsSection = {
  heading: string;
  paragraphs: string[];
};

const documentLines = TERMS_AND_CONDITIONS_TEXT.split(/\r?\n/);
const companyName = documentLines[0] ?? "";
const documentTitle = documentLines[1] ?? "";
const documentDetails = documentLines.slice(2, 6);
const documentTagline = documentLines[6] ?? "";
const sectionHeadingPattern = /^\d+\.\s+[A-Z]/;

const termsSections: TermsSection[] = [];
let currentSection: TermsSection | undefined;

for (const line of documentLines.slice(7)) {
  if (!line.trim()) {
    const previousLine = currentSection?.paragraphs[currentSection.paragraphs.length - 1];
    if (currentSection && previousLine !== "") {
      currentSection.paragraphs.push("");
    }
    continue;
  }

  if (sectionHeadingPattern.test(line)) {
    currentSection = { heading: line, paragraphs: [] };
    termsSections.push(currentSection);
    continue;
  }

  currentSection?.paragraphs.push(line);
}

export const metadata: Metadata = {
  title: "International Terms and Conditions of Carriage and Logistics Services | Swiftline Cargo",
  description:
    "Swiftline Cargo and Express Logistics international terms and conditions of carriage and logistics services.",
  alternates: { canonical: "/terms-and-conditions" },
};

export default function TermsPage() {
  return (
    <>
      <header className="bg-[#0D1282] text-white">
        <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#F5B942]">
            {companyName}
          </p>
          <h1 className="mt-3 max-w-4xl text-2xl font-bold leading-tight tracking-tight sm:text-3xl lg:text-4xl">
            {documentTitle}
          </h1>
          <div className="mt-6 grid max-w-4xl gap-x-10 gap-y-2 text-xs leading-6 text-white/80 sm:grid-cols-2">
            {documentDetails.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
          </div>
          <p className="mt-5 text-sm font-semibold text-white/90">{documentTagline}</p>
        </div>
      </header>

      <article className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
        <div className="w-full">
          {termsSections.map((section, sectionIndex) => (
            <section
              key={section.heading}
              className={
                sectionIndex === 0
                  ? "border-t border-slate-200 pt-0 first:border-t-0"
                  : "border-t border-slate-200 pt-8"
              }
            >
              <h2 className="text-base font-bold leading-7 tracking-wide text-[#0D1282] sm:text-lg">
                {section.heading}
              </h2>
              <div className="mt-4 space-y-3">
                {section.paragraphs.map((paragraph, paragraphIndex) => {
                  const key = section.heading + "-" + paragraphIndex;
                  if (!paragraph) {
                    return (
                      <div key={key} aria-hidden="true" className="h-2" />
                    );
                  }

                  const countryEntries = getCountryEntries(paragraph);
                  if (countryEntries) {
                    return (
                      <p
                        key={key}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-7 text-slate-600"
                      >
                        {countryEntries.map(({ label, Flag }, index) => (
                          <span key={label} className="inline-flex items-center gap-1.5">
                            <Flag
                              aria-hidden="true"
                              className="h-4 w-6 shrink-0 rounded-[2px] ring-1 ring-black/10"
                            />
                            <span>{label}</span>
                            {index < countryEntries.length - 1 && (
                              <span className="ml-0.5 text-slate-400">
                                •
                              </span>
                            )}
                          </span>
                        ))}
                      </p>
                    );
                  }

                  const contactMatch = paragraph.match(
                    /^[^\p{L}\p{N}]*\s*(Email|Phone|Website):\s*(.+)$/u
                  );
                  if (contactMatch) {
                    const ContactIcon =
                      contactMatch[1] === "Email"
                        ? FiMail
                        : contactMatch[1] === "Phone"
                          ? FiPhone
                          : FiGlobe;

                    return (
                      <p key={key} className="flex items-start gap-2 leading-7 text-slate-600">
                        <ContactIcon
                          aria-hidden="true"
                          className="mt-1 h-4 w-4 shrink-0 text-[#0D1282]"
                        />
                        <span>
                          {contactMatch[1]}: {contactMatch[2]}
                        </span>
                      </p>
                    );
                  }

                  return (
                    <p
                      key={key}
                      className={
                        /^\d+\.\d+\./.test(paragraph)
                          ? "leading-7 text-slate-700"
                          : "pl-4 leading-7 text-slate-600"
                      }
                    >
                      {paragraph}
                    </p>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </article>
    </>
  );
}
