import { z } from "zod";

export const appTypes = [
  "saas",
  "ecommerce",
  "mobile_app",
  "marketplace",
  "content_platform",
  "other",
] as const;

export const useCases = ["referrals", "affiliates"] as const;

export const useCaseDescriptions: Record<(typeof useCases)[number], string> = {
  referrals: "Let customers invite friends from inside your product.",
  affiliates:
    "Manage partner and creator referrals with links, attribution, and payouts.",
};

export const paymentProviders = [
  "stripe",
  "chargebee",
  "lemonsqueezy",
  "paddle",
  "other",
] as const;

// ───────────────────────────────────────────────────────────────
// Unified schema for the entire onboarding flow
// ───────────────────────────────────────────────────────────────
const onboardingFields = z.object({
  productName: z.string().min(1, "Product name is required").max(100),
  productUrl: z
    .string()
    .min(1, "Website URL is required")
    .transform((val) => {
      // Add https:// if no protocol is specified
      if (!val.match(/^https?:\/\//)) {
        return `https://${val}`;
      }
      return val;
    })
    .pipe(z.url({ message: "Please enter a valid URL" })),
  appType: z.enum(appTypes, {
    message: "Please select an app type",
  }),
  useCase: z
    .array(z.enum(useCases))
    .min(1, "Please select at least one option"),
  paymentProvider: z.enum(paymentProviders, {
    message: "Please select a payment provider",
  }),
  otherPaymentProvider: z.string(),
});

export const onboardingSchema = onboardingFields.refine(
  (data) => {
    // If "other" is selected, otherPaymentProvider must be provided
    if (data.paymentProvider === "other") {
      return (
        data.otherPaymentProvider && data.otherPaymentProvider.trim().length > 0
      );
    }
    return true;
  },
  {
    message: "Please specify your payment provider",
    path: ["otherPaymentProvider"],
  },
);

// ───────────────────────────────────────────────────────────────
// Step-level schemas derived from the master onboarding schema
// ───────────────────────────────────────────────────────────────

export const productInfoSchema = onboardingFields.pick({
  productName: true,
  productUrl: true,
});

export const appTypeSchema = onboardingFields.pick({
  appType: true,
});

export const useCaseSchema = onboardingFields.pick({
  useCase: true,
});

export const paymentProviderSchema = onboardingFields
  .pick({ paymentProvider: true, otherPaymentProvider: true })
  .refine(
    (data) => {
      if (data.paymentProvider === "other") {
        return (
          data.otherPaymentProvider &&
          data.otherPaymentProvider.trim().length > 0
        );
      }
      return true;
    },
    {
      message: "Please specify your payment provider",
      path: ["otherPaymentProvider"],
    },
  );

export type ProductInfoFormData = z.infer<typeof productInfoSchema>;
export type AppTypeFormData = z.infer<typeof appTypeSchema>;
export type UseCaseFormData = z.infer<typeof useCaseSchema>;
export type PaymentProviderFormData = z.infer<typeof paymentProviderSchema>;
export type OnboardingFormData = z.infer<typeof onboardingSchema>;

// Type helpers for optional fields
export type AppType = (typeof appTypes)[number];
export type UseCase = (typeof useCases)[number];
export type PaymentProvider = (typeof paymentProviders)[number];

export const appTypeLabels: Record<(typeof appTypes)[number], string> = {
  saas: "SaaS",
  ecommerce: "E-commerce",
  mobile_app: "Mobile App",
  marketplace: "Marketplace",
  content_platform: "Content Platform",
  other: "Other",
};

export const useCaseLabels: Record<(typeof useCases)[number], string> = {
  referrals: "Customer Referrals",
  affiliates: "Affiliate Program",
};

export const paymentProviderLabels: Record<
  (typeof paymentProviders)[number],
  string
> = {
  stripe: "Stripe",
  chargebee: "Chargebee",
  lemonsqueezy: "LemonSqueezy",
  paddle: "Paddle",
  other: "Other",
};
