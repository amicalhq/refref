import { describe, expect, it } from "vitest";
import {
  onboardingSchema,
  productInfoSchema,
  paymentProviderSchema,
} from "./onboarding";

describe("onboarding validation", () => {
  it("validates product information without requiring later steps", () => {
    expect(
      productInfoSchema.parse({
        productName: "Example",
        productUrl: "example.com",
      }),
    ).toEqual({ productName: "Example", productUrl: "https://example.com" });
  });

  it("keeps product field validation", () => {
    expect(
      productInfoSchema.safeParse({ productName: "", productUrl: "not a url" })
        .success,
    ).toBe(false);
  });

  it("requires a custom provider in the payment step and complete form", () => {
    const provider = { paymentProvider: "other", otherPaymentProvider: " " };
    expect(paymentProviderSchema.safeParse(provider).success).toBe(false);
    const form = {
      productName: "Example",
      productUrl: "example.com",
      appType: "saas",
      useCase: ["referrals"],
      ...provider,
    };
    expect(onboardingSchema.safeParse(form).success).toBe(false);
    expect(
      onboardingSchema.safeParse({
        ...form,
        otherPaymentProvider: "Custom Provider",
      }).success,
    ).toBe(true);
  });
});
