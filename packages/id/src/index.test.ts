import { describe, expect, it } from "vitest";
import {
  createId,
  getValidEntityTypes,
  InvalidEntityError,
  isValidEntityType,
  type EntityType,
} from "./index";

describe("@refref/id", () => {
  describe("createId", () => {
    it("should create IDs with correct format", () => {
      const id = createId("user");
      // Format: prefix_cuid2 where cuid2 is 24 chars
      expect(id).toMatch(/^usr_[a-z0-9]{24}$/);
    });

    it("should create unique IDs", () => {
      const ids = new Set<string>();
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        ids.add(createId("user"));
      }

      expect(ids.size).toBe(iterations);
    });

    it("should throw InvalidEntityError for invalid entity types", () => {
      expect(() => createId("invalid" as EntityType)).toThrow(
        InvalidEntityError,
      );
      expect(() => createId("unknown" as EntityType)).toThrow(
        InvalidEntityError,
      );
    });

    describe("entity type prefixes", () => {
      const entityTests: [EntityType, string][] = [
        ["user", "usr"],
        ["session", "ses"],
        ["account", "acc"],
        ["verification", "ver"],
        ["product", "prd"],
        ["productUser", "pu"],
        ["invitation", "inv"],
        ["apikey", "key"],
        ["programTemplate", "pgt"],
        ["program", "prg"],
        ["programUser", "pru"],
        ["eventDefinition", "evd"],
        ["participant", "prt"],
        ["rewardRule", "rwr"],
        ["reward", "rwd"],
        ["productSecrets", "psec"],
        ["refcode", "rc"],
        ["reflink", "rl"],
        ["referral", "ref"],
        ["event", "evt"],
        ["org", "org"],
        ["orgUser", "ou"],
      ];

      it.each(entityTests)(
        "should create %s ID with %s prefix",
        (entityType, expectedPrefix) => {
          const id = createId(entityType);
          expect(id).toMatch(new RegExp(`^${expectedPrefix}_[a-z0-9]{24}$`));
        },
      );
    });
  });

  describe("isValidEntityType", () => {
    it("should return true for valid entity types", () => {
      expect(isValidEntityType("user")).toBe(true);
      expect(isValidEntityType("product")).toBe(true);
      expect(isValidEntityType("program")).toBe(true);
      expect(isValidEntityType("reward")).toBe(true);
    });

    it("should return false for invalid entity types", () => {
      expect(isValidEntityType("invalid")).toBe(false);
      expect(isValidEntityType("unknown")).toBe(false);
      expect(isValidEntityType("")).toBe(false);
      expect(isValidEntityType("User")).toBe(false);
    });
  });

  describe("getValidEntityTypes", () => {
    it("should return an array of all valid entity types", () => {
      const validTypes = getValidEntityTypes();

      expect(Array.isArray(validTypes)).toBe(true);
      expect(validTypes.length).toBeGreaterThan(0);
      expect(validTypes).toContain("user");
      expect(validTypes).toContain("product");
      expect(validTypes).toContain("program");
    });

    it("should return all 22 entity types", () => {
      const validTypes = getValidEntityTypes();
      expect(validTypes.length).toBe(22);
    });
  });

  describe("InvalidEntityError", () => {
    it("should have correct error message", () => {
      const error = new InvalidEntityError("invalid");

      expect(error.message).toContain("Invalid entity type: invalid");
      expect(error.message).toContain("Valid types are:");
      expect(error.name).toBe("InvalidEntityError");
    });

    it("should list all valid entity types in error message", () => {
      const error = new InvalidEntityError("test");
      const validTypes = getValidEntityTypes();

      validTypes.forEach((type) => {
        expect(error.message).toContain(type);
      });
    });
  });
});
