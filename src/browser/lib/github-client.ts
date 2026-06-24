import { Octokit } from "@octokit/core";

let _octokit: Octokit | null = null;

export function setOctokit(instance: Octokit | null) {
  _octokit = instance;
}

export function getOctokit(): Octokit {
  if (!_octokit) throw new Error("Not authenticated");
  return _octokit;
}
