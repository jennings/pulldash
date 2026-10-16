export function browserBuildMode(development: boolean) {
  return {
    minify: !development,
    define: {
      __DEV__: JSON.stringify(development),
      "process.env.NODE_ENV": JSON.stringify(
        development ? "development" : "production"
      ),
    },
  };
}

export async function verifyProductionBundle(
  outputs: Array<{ path: string; text: () => Promise<string> }>
) {
  const sources = await Promise.all(
    outputs
      .filter((output) => output.path.endsWith(".js"))
      .map((output) => output.text())
  );
  if (
    sources.some((source) =>
      /react(?:-dom)?(?:-client)?\.development\.js|Download the React DevTools|process\.env\.NODE_ENV/.test(
        source
      )
    )
  ) {
    throw new Error(
      "Release bundle contains development code or unresolved NODE_ENV"
    );
  }
  if (!sources.some((source) => source.includes("Minified React error #"))) {
    throw new Error("Release bundle is missing the production React runtime");
  }
}
