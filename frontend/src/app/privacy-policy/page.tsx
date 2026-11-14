import type { Metadata } from "next";
import type { ReactNode } from "react";
import PublicFooter from "@/components/public/PublicFooter";
import PublicHeader from "@/components/public/PublicHeader";
import styles from "./privacy-policy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Swiftline Cargo",
  description:
    "How Swiftline collects, uses, shares, retains and protects personal data across its websites, client portals, applications and logistics services."
};

const EFFECTIVE_DATE = "1 February 2025";
const LAST_UPDATED = "27 July 2026";

/** Single source of truth for the contents list, the anchors and the numbering
    printed in each heading, so the three can never drift apart. */
const SECTIONS = [
  { id: "about-this-policy", title: "About this Policy" },
  { id: "swiftline-entities", title: "Swiftline entities and responsibility" },
  { id: "scope", title: "Scope" },
  { id: "personal-data-we-collect", title: "Personal data we collect" },
  { id: "data-about-other-people", title: "Data received about other people" },
  { id: "how-we-collect", title: "How we collect personal data" },
  { id: "how-and-why-we-use", title: "How and why we use personal data" },
  { id: "lawful-bases", title: "Lawful bases" },
  { id: "shipment-and-tracking-data", title: "Shipment, tracking, barcode and scanning data" },
  { id: "customs-and-government", title: "Customs, aviation security and government requirements" },
  { id: "automated-processing", title: "Automated processing and analytics" },
  { id: "sharing-personal-data", title: "Sharing personal data" },
  { id: "international-transfers", title: "International data transfers" },
  { id: "data-security", title: "Data security" },
  { id: "personal-data-breaches", title: "Personal data breaches" },
  { id: "data-retention", title: "Data retention" },
  { id: "cookies", title: "Cookies and similar technologies" },
  { id: "location-data", title: "Location data" },
  { id: "cctv", title: "CCTV and premises security" },
  { id: "marketing", title: "Marketing communications" },
  { id: "childrens-data", title: "Children’s data" },
  { id: "user-responsibilities", title: "Customer and portal-user responsibilities" },
  { id: "individual-rights", title: "Individual rights" },
  { id: "grievances", title: "Grievances and complaints" },
  { id: "third-party-links", title: "Third-party links and services" },
  { id: "changes", title: "Changes to this Policy" },
  { id: "contact-details", title: "Contact details" },
  { id: "copyright", title: "Copyright and trademark notice" }
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SECTION_HEADINGS = Object.fromEntries(
  SECTIONS.map((section, index) => [section.id, `${index + 1}. ${section.title}`])
) as Record<SectionId, string>;

const PRINCIPLES = [
  { title: "Purpose", body: "We use data only for clear and lawful purposes." },
  { title: "Security", body: "We apply proportionate technical and organisational safeguards." },
  { title: "Choice", body: "We respect applicable rights and communication preferences." },
  { title: "Accountability", body: "We document, review and improve our privacy practices." }
];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-slate-200 pt-10 first:border-t-0 first:pt-0">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900 sm:text-xl">{SECTION_HEADINGS[id]}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-2 text-xs font-semibold uppercase tracking-widest text-[#0D1282]">{children}</h3>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span aria-hidden className="mt-3 h-1 w-1 shrink-0 rounded-full bg-[#F5B942]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-[#0D1282]">{title}</p>
      <div className="mt-3 space-y-3 text-sm leading-7 text-slate-600">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-200 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 sm:w-52 sm:shrink-0">
        {label}
      </span>
      {href ? (
        <a href={href} className="wrap-break-word text-sm text-[#0D1282] hover:underline">
          {value}
        </a>
      ) : (
        <span className="wrap-break-word text-sm text-slate-700">{value}</span>
      )}
    </div>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <PublicHeader />
      <main className="flex-1">
        <section className="bg-[#0D1282] text-white">
          <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F5B942]">Swiftline&reg; Privacy Policy</p>
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
            How we collect, use and protect personal data
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-white/70">
            For websites, client portals, business accounts, mobile applications, shipment systems and logistics
            services.
          </p>

          <dl className="mt-10 grid gap-6 border-t border-white/15 pt-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Effective date", value: EFFECTIVE_DATE },
              { label: "Last updated", value: LAST_UPDATED },
              { label: "Policy owner", value: "Swiftline- Data Protection & Compliance" },
              {
                label: "Applies to",
                value: "Swiftline Cargo Ltd® and Swiftline Cargo & Express Logistics Private Limited"
              }
            ].map((item) => (
              <div key={item.label}>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">{item.label}</dt>
                <dd className="mt-1.5 text-sm leading-6 text-white">{item.value}</dd>
              </div>
            ))}
          </dl>
          </div>
        </section>

      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <section className="max-w-3xl">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Privacy at Swiftline</h2>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Swiftline recognises that trust is essential to every shipment and every digital interaction. We process
            personal data responsibly, transparently and securely, and only for legitimate business, contractual,
            operational, security and legal purposes.
          </p>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            This Privacy Policy explains what information we collect, why we use it, how it may be shared, how long it
            is retained, the safeguards we apply and the rights available to individuals under applicable
            data-protection laws.
          </p>
        </section>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((principle) => (
            <div key={principle.title} className="rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#0D1282]">{principle.title}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{principle.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 gap-12 lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Contents" className="mb-12 lg:mb-0 print:hidden">
            <div className="lg:sticky lg:top-24">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Contents</p>
              <ol
                className={[
                  styles.contentsList,
                  "mt-4",
                  "space-y-1.5",
                  "lg:max-h-[calc(100vh-9rem)]",
                  "lg:overflow-y-auto",
                  "lg:pr-2",
                ].join(" ")}
              >
                {SECTIONS.map((section, index) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="flex gap-2.5 rounded-md py-1 text-sm leading-6 text-slate-600 transition hover:text-[#0D1282]"
                    >
                      <span className="w-5 shrink-0 text-right text-xs leading-6 text-slate-400">{index + 1}</span>
                      <span>{section.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>

          <div className="max-w-3xl space-y-10">
            <Section id="about-this-policy">
              <p>
                This Privacy Policy describes how Swiftline Cargo Ltd&reg; and Swiftline Cargo &amp; Express Logistics
                Private Limited (together, &ldquo;Swiftline&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; or
                &ldquo;our&rdquo;) collect, use, disclose, transfer, store and protect personal data. It applies
                whenever an individual or organisation visits our websites, creates or uses an account, accesses a
                customer or business portal, uses a mobile or desktop application, books or manages a shipment, receives
                a delivery, contacts us, works with us as a service partner, or otherwise interacts with our services.
              </p>
              <p>
                This Policy should be read together with our Terms and Conditions, Cookie Policy, Prohibited and
                Restricted Goods Policy, service-specific notices, contractual terms and any other privacy notice
                provided at the point personal data is collected.
              </p>
              <p>
                Where local law provides stronger rights or protections than this Policy, the applicable local law will
                prevail.
              </p>
            </Section>

            <Section id="swiftline-entities">
              <p>
                The Swiftline entity responsible for personal data depends on the service, location, contract and
                operational role involved.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Card title="United Kingdom">
                  <p>
                    Swiftline Cargo Ltd&reg; provides and supports courier, cargo, freight, customs, fulfilment,
                    collection, delivery and related logistics services in the United Kingdom and internationally.
                  </p>
                </Card>
                <Card title="India">
                  <p>
                    Swiftline Cargo &amp; Express Logistics Private Limited provides and supports courier, cargo,
                    freight, export, import, customs, collection, delivery, technology and related logistics services in
                    India and internationally.
                  </p>
                </Card>
              </div>
              <p>
                The relevant entity may act as a data controller, joint controller or processor depending on the
                circumstances. Swiftline entities may share data with each other where necessary to provide services,
                manage customer relationships, secure systems, meet legal obligations and operate the Swiftline network.
              </p>
            </Section>

            <Section id="scope">
              <p>This Policy applies to personal data processed through:</p>
              <List
                items={[
                  "Our websites and online forms;",
                  "Customer, business, freight-forwarder, exporter, manufacturer and partner portals;",
                  "Mobile, tablet, driver and delivery applications;",
                  "Booking, quotation, billing, payment and account systems;",
                  "Shipment tracking, barcode, scanning, bagging, manifesting and warehouse systems;",
                  "Customs-clearance, aviation-security and electronic data-interchange systems;",
                  "Application programming interfaces and partner integrations;",
                  "Email, telephone, SMS, WhatsApp, social media, chat and support channels;",
                  "Collection, transport, storage, screening, customs, delivery, returns and claims operations;",
                  "CCTV, access-control and security systems at relevant facilities."
                ]}
              />
            </Section>

            <Section id="personal-data-we-collect">
              <SubHeading>4.1 Identity and contact data</SubHeading>
              <List
                items={[
                  "Name, title, job role and organisation;",
                  "Email address, telephone number and mobile number;",
                  "Residential, business, collection, billing and delivery addresses;",
                  "Customer number, account identifier and authorised-user information;",
                  "Signature, photograph or image where required for proof of service;",
                  "Date of birth and government-issued identification where legally required;",
                  "Passport, tax, VAT, GST, importer/exporter, licence or registration information where required."
                ]}
              />

              <SubHeading>4.2 Account and authentication data</SubHeading>
              <List
                items={[
                  "Username, encrypted password and mobile OTP verification records;",
                  "Account preferences, saved addresses, permissions and authorised users;",
                  "Login history, IP address, device identifier, browser and operating-system information;",
                  "Session details, security events, portal activity and audit logs;",
                  "Uploaded files, account communications and customer-support history."
                ]}
              />

              <SubHeading>4.3 Shipment and logistics data</SubHeading>
              <List
                items={[
                  "Sender, recipient, consignee, importer, exporter and contact details;",
                  "Shipment description, content, declared value, insured value, weight, dimensions and piece count;",
                  "Country of origin, destination, route, service level and delivery instructions;",
                  "Tracking number, barcode, house airway bill, master airway bill, manifest, bag and pallet details;",
                  "Collection events, sorting events, transfer events, customs status, delivery attempts and exceptions;",
                  "Proof of collection, proof of delivery, signature, delivery image and location evidence;",
                  "Loss, damage, claim, return, prohibited-goods and investigation information."
                ]}
              />

              <SubHeading>4.4 Customs and regulatory data</SubHeading>
              <List
                items={[
                  "Commercial invoices, packing lists and customs declarations;",
                  "Product descriptions, commodity codes and country-of-origin information;",
                  "Import/export licences, KYC documents and authority letters;",
                  "Tax, duty, sanctions, restricted-party and compliance-screening information;",
                  "Security declarations and documents required by airlines, airports, customs or government authorities."
                ]}
              />

              <SubHeading>4.5 Financial and transaction data</SubHeading>
              <List
                items={[
                  "Billing details, invoices, account balances and payment status;",
                  "Bank information, transaction references, refunds, credit limits and remittance records;",
                  "Tax records, payment disputes and debt-recovery information;",
                  "Fraud-prevention signals associated with a payment or account."
                ]}
              />
              <p>
                Payment cards are ordinarily processed by authorised payment-service providers. Swiftline does not
                generally store complete card numbers or card security codes.
              </p>

              <SubHeading>4.6 Technical and usage data</SubHeading>
              <List
                items={[
                  "IP address, device and browser details;",
                  "Pages, features and services accessed;",
                  "Clickstream, navigation, timestamps and error reports;",
                  "Application performance, diagnostics and security logs;",
                  "Cookie, analytics and session identifiers;",
                  "Approximate location derived from IP address and, where authorised, precise device location."
                ]}
              />

              <SubHeading>4.7 Communications data</SubHeading>
              <p>
                We may retain messages and other communications sent by email, telephone, SMS, WhatsApp, chat, web
                forms, social media or customer-support channels. Calls may be recorded where lawful for training,
                service quality, security, compliance and dispute resolution.
              </p>
            </Section>

            <Section id="data-about-other-people">
              <p>
                Customers and business users often provide personal data about senders, recipients, consignees,
                employees, authorised users, suppliers and other individuals. The person or organisation providing that
                information must ensure that it is accurate, lawfully obtained and appropriately disclosed to Swiftline.
              </p>
              <p>
                Customers should provide only the information reasonably required for the shipment or service and should
                ensure that affected individuals receive any privacy notice required by law.
              </p>
            </Section>

            <Section id="how-we-collect">
              <p>We may collect personal data:</p>
              <List
                items={[
                  "Directly from the individual;",
                  "From a business customer, sender, recipient, consignee, account administrator or authorised representative;",
                  "Through our websites, portals, applications and customer-service channels;",
                  "From barcode scans, delivery devices, operational personnel and warehouse systems;",
                  "From airlines, courier partners, customs brokers, freight forwarders, carriers and delivery providers;",
                  "From customs, tax, border, police, aviation and other competent authorities;",
                  "From banks, payment providers, identity-verification and fraud-prevention providers;",
                  "From public business registers and other lawful public sources;",
                  "Through cookies and similar technologies."
                ]}
              />
            </Section>

            <Section id="how-and-why-we-use">
              <SubHeading>7.1 Delivering logistics services</SubHeading>
              <List
                items={[
                  "Providing quotations and opening customer or business accounts;",
                  "Booking, collecting, screening, transporting, sorting, storing and delivering shipments;",
                  "Generating shipping labels, barcodes, manifests and electronic shipment data;",
                  "Managing airline, carrier, warehouse, partner and last-mile operations;",
                  "Performing customs clearance and regulatory submissions;",
                  "Providing shipment tracking, notifications and proof of delivery;",
                  "Handling returns, claims, loss, damage, disputes and service exceptions."
                ]}
              />

              <SubHeading>7.2 Account and customer management</SubHeading>
              <List
                items={[
                  "Verifying users and maintaining account access;",
                  "Managing contracts, contacts, service settings and authorised users;",
                  "Responding to enquiries, support requests, grievances and complaints;",
                  "Providing invoices, statements, operational updates and service communications;",
                  "Monitoring service quality and relationship performance."
                ]}
              />

              <SubHeading>7.3 Payments, billing and credit</SubHeading>
              <List
                items={[
                  "Processing payments, refunds and remittances;",
                  "Issuing invoices and managing credit facilities;",
                  "Recovering outstanding sums and resolving payment disputes;",
                  "Maintaining tax, accounting and audit records."
                ]}
              />

              <SubHeading>7.4 Security, fraud prevention and compliance</SubHeading>
              <List
                items={[
                  "Protecting customer accounts, facilities, systems and shipments;",
                  "Detecting fraud, suspicious activity, identity misuse and unauthorised access;",
                  "Screening prohibited or restricted goods and sanctioned parties;",
                  "Investigating incidents, claims, theft, loss, damage and misconduct;",
                  "Complying with customs, aviation, export-control, sanctions, tax, court and law-enforcement obligations."
                ]}
              />

              <SubHeading>7.5 Improvement and analytics</SubHeading>
              <List
                items={[
                  "Improving websites, portals, applications, routes and operational processes;",
                  "Analysing service performance, capacity, exceptions and customer experience;",
                  "Diagnosing technical faults and protecting platform reliability;",
                  "Developing new features, products and business services;",
                  "Creating aggregated or anonymised business insights."
                ]}
              />

              <SubHeading>7.6 Marketing and business development</SubHeading>
              <p>
                Where permitted, we may send information about Swiftline services, offers, new features and business
                opportunities. Individuals may opt out of promotional communications at any time. Operational, legal,
                security, billing and shipment messages may still be sent where necessary.
              </p>
            </Section>

            <Section id="lawful-bases">
              <p>
                Depending on the relevant law and circumstances, Swiftline may rely on one or more of the following
                legal grounds:
              </p>
              <List
                items={[
                  <>
                    <strong className="font-semibold text-slate-900">Contract</strong> &mdash; where processing is
                    necessary to provide a quotation, create an account, book or deliver a shipment, collect payment or
                    perform another contractual obligation;
                  </>,
                  <>
                    <strong className="font-semibold text-slate-900">Legal obligation</strong> &mdash; where processing
                    is required by customs, tax, aviation-security, sanctions, court, police, regulatory or other legal
                    requirements;
                  </>,
                  <>
                    <strong className="font-semibold text-slate-900">Legitimate interests</strong> &mdash; where
                    necessary to operate and improve our services, protect shipments and systems, prevent fraud, manage
                    customer relationships, recover debts, resolve disputes or protect legal rights, provided those
                    interests are not overridden by individual rights;
                  </>,
                  <>
                    <strong className="font-semibold text-slate-900">Consent</strong> &mdash; where required for a
                    specific activity, including certain marketing or device-permission functions;
                  </>,
                  <>
                    <strong className="font-semibold text-slate-900">Vital interests or public-interest grounds</strong>{" "}
                    &mdash; in limited circumstances where permitted by law.
                  </>
                ]}
              />
            </Section>

            <Section id="shipment-and-tracking-data">
              <p>
                Swiftline may assign each shipment, parcel, bag, pallet or piece a unique barcode, tracking number or
                other identifier. Each operational scan may record the identifier, date, time, location, processing
                facility, user or operator, scanner or device, shipment status, route and exception details.
              </p>
              <p>
                This information supports chain of custody, tracking, reconciliation, manifesting, customs, bagging,
                warehouse control, service quality, fraud prevention and proof of collection or delivery.
              </p>
              <p>
                Tracking data may be made available to authorised senders, recipients, account holders, consignees and
                service partners. Users must not attempt to access shipment information without proper authority.
              </p>
            </Section>

            <Section id="customs-and-government">
              <p>
                International shipments are subject to customs, border-control, aviation-security, import, export, tax,
                sanctions and other regulatory requirements. Swiftline may submit personal and shipment data to
                competent authorities before, during or after transport.
              </p>
              <p>
                The data submitted may include identity and contact details, shipment contents, values, commodity codes,
                origin and destination, payment information and supporting documents. Authorities process such
                information under their own legal powers and privacy responsibilities.
              </p>
            </Section>

            <Section id="automated-processing">
              <p>
                We may use automated tools to support address validation, rate calculation, routing, fraud detection,
                account security, prohibited-goods checks, sanctions screening, customs-data validation, duplicate
                detection, shipment-risk assessment and operational prioritisation.
              </p>
              <p>
                Where applicable law grants a right relating to solely automated decisions with significant effects,
                individuals may request information, express their view, challenge the outcome and request human review.
              </p>
            </Section>

            <Section id="sharing-personal-data">
              <p>We may share personal data where reasonably necessary with:</p>
              <List
                items={[
                  "Swiftline group companies and authorised personnel;",
                  "Airlines, courier companies, postal operators, freight forwarders, road carriers and delivery partners;",
                  "Customs brokers, warehouses, fulfilment providers and screening facilities;",
                  "Customs, border, tax, airport, aviation-security, regulatory, police and government authorities;",
                  "Banks, payment processors, credit-reference and fraud-prevention providers;",
                  "Cloud, hosting, software, analytics, communications and cybersecurity providers;",
                  "Auditors, insurers, lawyers, accountants, consultants and professional advisers;",
                  "Debt-recovery providers and dispute-resolution bodies;",
                  "Potential purchasers, investors or successors in connection with a legitimate corporate transaction."
                ]}
              />
              <p className="rounded-xl border border-[#0D1282]/15 bg-[#0D1282]/5 p-5 text-slate-700">
                <strong className="font-semibold text-slate-900">Swiftline does not sell personal data.</strong> Service
                providers are expected to process personal data only for authorised purposes and to maintain appropriate
                confidentiality and security.
              </p>
            </Section>

            <Section id="international-transfers">
              <p>
                Because logistics services are international, personal data may be transferred to or accessed from
                countries other than the country where it was collected. This may occur when a shipment, customer,
                recipient, airline, partner, customs authority, data centre or service provider is located abroad.
              </p>
              <p>
                Where required, Swiftline uses appropriate transfer safeguards, which may include contractual clauses,
                data-processing agreements, access controls, encryption, transfer assessments and other legally
                recognised mechanisms.
              </p>
            </Section>

            <Section id="data-security">
              <p>
                Swiftline maintains technical and organisational measures designed to protect personal data against
                accidental or unlawful destruction, loss, alteration, disclosure, access or misuse. Measures may
                include:
              </p>
              <List
                items={[
                  "Encryption in transit and encryption at rest where appropriate;",
                  "Secure hosting, firewalls and network controls;",
                  "Role-based access and least-privilege permissions;",
                  "OTP, password controls and multi-factor authentication where available;",
                  "Monitoring, audit logs, backups and malware protection;",
                  "Vulnerability management and incident-response procedures;",
                  "Confidentiality commitments and staff awareness;",
                  "Supplier due diligence and contractual security obligations."
                ]}
              />
              <p>
                No internet-connected system can be guaranteed to be completely secure. Customers must protect
                passwords, OTPs, devices and account credentials and notify Swiftline promptly of suspected unauthorised
                activity.
              </p>
            </Section>

            <Section id="personal-data-breaches">
              <p>
                If Swiftline becomes aware of a personal data breach, we will assess its nature, scope, likely impact
                and risk. We may take steps to contain the incident, secure affected systems, investigate the cause,
                recover information and prevent recurrence.
              </p>
              <p>
                Where legally required, we will notify the relevant supervisory authority and affected individuals
                within the applicable period.
              </p>
            </Section>

            <Section id="data-retention">
              <p>
                We retain personal data only for as long as reasonably necessary for the purposes described in this
                Policy and to meet contractual, customs, aviation, tax, accounting, insurance, security, legal-claim and
                regulatory requirements.
              </p>
              <p>
                Retention periods differ according to the type of data, service, legal obligation, limitation period,
                active claim, fraud risk or investigation. When data is no longer required, it may be securely deleted,
                anonymised or archived in accordance with applicable law and our retention procedures.
              </p>
            </Section>

            <Section id="cookies">
              <p>
                Our websites, portals and applications may use cookies, local storage, pixels and similar technologies
                to authenticate users, maintain secure sessions, remember preferences, prevent fraud, measure usage,
                diagnose errors and improve performance.
              </p>
              <p>
                Users can manage cookies through browser or device settings. Disabling essential cookies may prevent
                certain services from functioning correctly. Where required, non-essential cookies will be used only
                after appropriate consent.
              </p>
            </Section>

            <Section id="location-data">
              <p>
                Swiftline may process location information to arrange collections, validate addresses, plan routes,
                confirm delivery, display shipment progress, protect drivers and shipments, and investigate service
                disputes.
              </p>
              <p>
                Precise device location will be accessed only where necessary, permitted by law and authorised through
                the relevant device or application permission.
              </p>
            </Section>

            <Section id="cctv">
              <p>
                Swiftline facilities, offices, warehouses and operational areas may use CCTV, access-control or other
                security systems for safety, crime prevention, shipment protection, access management, incident
                investigation and protection of people and property.
              </p>
              <p>
                Recordings are retained for an appropriate period unless required for an investigation, legal claim,
                insurance matter or regulatory purpose.
              </p>
            </Section>

            <Section id="marketing">
              <p>
                Where lawful, Swiftline may use business contact details to communicate service information, offers,
                product updates and other relevant business material. Recipients can unsubscribe using the option
                provided in the message or by contacting us.
              </p>
              <p>
                Opting out of marketing does not stop essential shipment, customs, account, security, billing, service
                interruption or contractual communications.
              </p>
            </Section>

            <Section id="childrens-data">
              <p>
                Swiftline services are primarily intended for businesses and adults capable of entering legally binding
                transactions. Children should not independently create commercial shipping accounts.
              </p>
              <p>
                Where personal data relating to a child is genuinely required for a lawful shipment, customs process or
                delivery, it must be supplied by an authorised parent, guardian or responsible organisation and will be
                used only for the relevant lawful purpose.
              </p>
            </Section>

            <Section id="user-responsibilities">
              <p>Customers, account administrators and portal users must:</p>
              <List
                items={[
                  "Provide accurate, current and lawful information;",
                  "Ensure they have authority to provide personal data relating to other individuals;",
                  "Protect usernames, passwords, OTPs and devices;",
                  "Use Swiftline systems only for authorised and lawful purposes;",
                  "Avoid uploading unnecessary sensitive or confidential information;",
                  "Comply with customs, sanctions, prohibited-goods and shipping requirements;",
                  "Notify Swiftline promptly of unauthorised access or incorrect data;",
                  "Ensure authorised users follow applicable terms and privacy requirements."
                ]}
              />
            </Section>

            <Section id="individual-rights">
              <p>Subject to applicable law and relevant exemptions, individuals may have the right to:</p>
              <List
                items={[
                  "Request confirmation of whether Swiftline processes their personal data;",
                  "Request access to personal data;",
                  "Request correction of inaccurate or incomplete information;",
                  "Request deletion or erasure;",
                  "Request restriction of processing;",
                  "Object to certain processing;",
                  "Withdraw consent where processing is based on consent;",
                  "Request portability of eligible data;",
                  "Opt out of direct marketing;",
                  "Request information about significant automated decisions and seek human review;",
                  "Nominate another person to exercise rights where permitted;",
                  "Raise a grievance or complain to a competent authority."
                ]}
              />
              <p>
                Some requests may be limited where Swiftline must retain or process information for customs, tax,
                security, fraud prevention, legal claims, regulatory duties or the rights of others. We may request
                proof of identity or authority before acting on a request.
              </p>
            </Section>

            <Section id="grievances">
              <SubHeading>24.1 Grievance Officer</SubHeading>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
                <DetailRow label="Name" value="Ravi Yadav" />
                <DetailRow label="Designation" value="Director and Grievance Officer" />
                <DetailRow label="Email" value="director@swiftlineindia.com" href="mailto:director@swiftlineindia.com" />
                <DetailRow label="Telephone" value="+91 70271 16600" href="tel:+917027116600" />
                <DetailRow label="Telephone / WhatsApp" value="+91 98177 17689" href="tel:+919817717689" />
                <DetailRow
                  label="Website"
                  value="www.swiftlinefreight.com"
                  href="https://www.swiftlinefreight.com"
                />
              </div>
              <p>
                A privacy request or grievance should include the individual&rsquo;s full name, registered contact
                details, relevant account or shipment reference, a clear description of the issue and any information
                reasonably required to verify identity and investigate the matter.
              </p>
              <p>
                Swiftline will acknowledge, assess and respond within the period required by applicable law. Complex
                matters, identity checks, active legal claims, customs investigations or regulatory restrictions may
                require additional time.
              </p>

              <SubHeading>24.2 Complaints to authorities</SubHeading>
              <p>
                Individuals may also have the right to complain to the competent data-protection authority. For
                processing in the United Kingdom, this may include the Information Commissioner&rsquo;s Office. For
                processing in India, this may include the authority or Data Protection Board having jurisdiction under
                applicable law.
              </p>
              <p>
                We encourage individuals to contact the Grievance Officer first so that Swiftline has an opportunity to
                investigate and resolve the concern promptly.
              </p>
            </Section>

            <Section id="third-party-links">
              <p>
                Swiftline platforms may link to or integrate with third-party websites, payment services, carrier
                systems, mapping tools, customs platforms and other services. Independent third parties are responsible
                for their own privacy and security practices.
              </p>
              <p>Users should review the relevant third-party privacy notice before providing information.</p>
            </Section>

            <Section id="changes">
              <p>
                Swiftline may update this Policy to reflect changes in law, regulatory guidance, technology, services,
                security measures or business operations. The revised version will be published with an updated
                &ldquo;Last updated&rdquo; date.
              </p>
              <p>
                Where a change materially affects how personal data is processed, Swiftline may provide additional
                notice through the website, portal, application, email or another appropriate channel.
              </p>
            </Section>

            <Section id="contact-details">
              <div className="grid gap-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[#0D1282]">
                    Swiftline Cargo Ltd&reg;
                  </p>
                  <div className="mt-3">
                    <DetailRow
                      label="Website"
                      value="www.swiftlinefreight.com"
                      href="https://www.swiftlinefreight.com"
                    />
                    <DetailRow
                      label="UK operations"
                      value="info@swiftlinecargo.co.uk"
                      href="mailto:info@swiftlinecargo.co.uk"
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[#0D1282]">
                    Swiftline Cargo &amp; Express Logistics Private Limited
                  </p>
                  <div className="mt-3">
                    <DetailRow
                      label="Website"
                      value="www.swiftlinefreight.com"
                      href="https://www.swiftlinefreight.com"
                    />
                    <DetailRow
                      label="General enquiries"
                      value="info@swiftlinefreight.com"
                      href="mailto:info@swiftlinefreight.com"
                    />
                    <DetailRow
                      label="Operations"
                      value="operations@swiftlineindia.com"
                      href="mailto:operations@swiftlineindia.com"
                    />
                    <DetailRow
                      label="Grievance Officer"
                      value="director@swiftlineindia.com"
                      href="mailto:director@swiftlineindia.com"
                    />
                    <DetailRow label="Telephone" value="+91 70271 16600" href="tel:+917027116600" />
                    <DetailRow label="Telephone / WhatsApp" value="+91 98177 17689" href="tel:+919817717689" />
                  </div>
                </div>
              </div>
            </Section>

            <Section id="copyright">
              <p>
                &copy; 2025&ndash;2026 Swiftline Cargo Ltd&reg; and Swiftline Cargo &amp; Express Logistics Private
                Limited. All rights reserved.
              </p>
              <p>
                Swiftline Cargo&reg;, the Swiftline name, logos, brand elements, portal designs, software,
                documentation, shipment processes and related intellectual property may not be copied, reproduced,
                distributed, modified or used without prior written authorisation.
              </p>
            </Section>
          </div>
        </div>
      </div>
      </main>
      <PublicFooter />
    </div>
  );
}
