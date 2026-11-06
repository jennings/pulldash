import { computeInterdiff } from "./interdiff";

export type WorkerRequest = {
  type: "interdiff";
  id: string;
  patch1: string;
  patch2: string;
};

export type WorkerResponse =
  | { type: "interdiff-result"; id: string; result: string }
  | { type: "error"; id: string; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type !== "interdiff") return;
    const result = computeInterdiff(request.patch1, request.patch2);
    self.postMessage({
      type: "interdiff-result",
      id: request.id,
      result,
    } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : "Unknown error",
    } satisfies WorkerResponse);
  }
};
