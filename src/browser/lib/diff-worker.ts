import {
  parseDiffWithHighlighting,
  highlightFileLines,
  compareFileContents,
  type WorkerRequest,
  type WorkerResponse,
} from "./diff-parser";
import { computeInterdiff } from "./interdiff";

export * from "./diff-parser";

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case "compare-content": {
        const result = compareFileContents(
          request.oldContent,
          request.newContent,
          request.filename,
          request.context
        );
        self.postMessage({
          type: "parse-diff-result",
          id: request.id,
          result,
        } as WorkerResponse);
        break;
      }
      case "parse-diff": {
        const result = parseDiffWithHighlighting(
          request.patch,
          request.filename,
          request.previousFilename,
          request.oldContent,
          request.newContent
        );

        // DEBUG: send line summary to main thread for diagnostics
        const debugLines: any[] = [];
        for (const h of result.hunks) {
          if (h.type === "hunk") {
            for (const l of h.lines) {
              debugLines.push({
                type: l.type,
                old: (l as any).oldLineNumber ?? (l as any).lineNumber,
                new: (l as any).newLineNumber,
                content: l.content?.map((s: any) => s.value).join("") ?? "",
              });
            }
          }
        }

        (self as any).postMessage({
          type: "parse-diff-result",
          id: request.id,
          result,
          _debug: { lines: debugLines },
        });
        break;
      }
      case "highlight-lines": {
        const result = highlightFileLines(
          request.content,
          request.filename,
          request.startLine,
          request.oldStartLine,
          request.count
        );
        self.postMessage({
          type: "highlight-lines-result",
          id: request.id,
          result,
        } as WorkerResponse);
        break;
      }
      case "interdiff": {
        const result = computeInterdiff(
          request.patch1,
          request.patch2,
          request.filename
        );
        self.postMessage({
          type: "interdiff-result",
          id: request.id,
          result,
        } as WorkerResponse);
        break;
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : "Unknown error",
    } as WorkerResponse);
  }
};
