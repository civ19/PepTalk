/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type --
 * Type parameters must match Vitest's own `Assertion` declaration for merging. */
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<
    any,
    any
  > {}
}
