import { expect, test } from "bun:test";
import { browserBuildMode, verifyProductionBundle } from "./browser-build-mode";

test("release React artifacts use production code while development keeps diagnostics", async () => {
  for (const development of [false, true]) {
    const result = await Bun.build({
      entrypoints: [Bun.resolveSync("react-dom/client", import.meta.dir)],
      target: "browser",
      ...browserBuildMode(development),
    });
    expect(result.success).toBe(true);
    if (development) {
      await expect(verifyProductionBundle(result.outputs)).rejects.toThrow(
        "development code"
      );
    } else {
      await verifyProductionBundle(result.outputs);
    }
  }
});

test("release verification rejects artifacts without production React", async () => {
  await expect(
    verifyProductionBundle([{ path: "empty.js", text: async () => "" }])
  ).rejects.toThrow("missing the production React runtime");
});
