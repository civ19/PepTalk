import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Register jest-dom matchers on this workspace's Vitest instance explicitly.
// `@testing-library/jest-dom/vitest` imports `vitest` from wherever jest-dom is
// hoisted, which can be a different Vitest version than the frontend's.
expect.extend(matchers);

afterEach(() => {
  cleanup();
});
