import * as core from "@actions/core";
import { context } from "@actions/github";
import * as Diff from "diff";
import { Change } from "diff";
import { Package } from "./bloat";
import { shouldIncludeInDiff } from "./utils";
import { AxiosInstance } from "axios";

declare interface CrateDifference {
  name: string;
  // If old is null, it's a new crate. If new is null, it's been deleted.
  // If both have values then it's changed.
  // If both are null then something has gone terribly wrong.
  old: number | null;
  new: number | null;
}

export declare interface SnapshotDifference {
  packageName: string;

  currentSize: number;
  oldSize: number;
  sizeDifference: number;

  currentTextSize: number;
  oldTextSize: number;
  textDifference: number;

  masterCommit: string | null;
  currentCommit: string;

  crateDifference: Array<CrateDifference>;
}

export declare interface Crate {
  crate: string | null;
  name: string;
  size: number;
}

export declare interface Snapshot {
  commit: string;
  toolchain: string;
  rustc: string;
  bloat: string;
  packages: Record<string, Package>;
}

function crateOrFunctionName(crate: Crate): string {
  const name = crate.crate ? `(${crate.crate}) ${crate.name}` : crate.name;
  if (name.length > 70) {
    return `${name.substring(0, 70)}...`;
  }
  return name;
}

export function compareSnapshots(packageName: string, masterCommit: string | null, current: Package, master: Package | null): SnapshotDifference {
  const masterFileSize = master?.bloat["file-size"] || 0;
  const masterTextSize = master?.bloat["text-section-size"] || 0;

  const sizeDifference = current.bloat["file-size"] - masterFileSize;
  const textDifference = current.bloat["text-section-size"] - masterTextSize;

  const currentCratesObj: { [key: string]: number } = {};
  const currentCrateOrFunction = current.bloat.crates ? current.bloat.crates : current.bloat.functions;
  const masterCrateOrFunction = master?.bloat.crates ? master?.bloat.crates : master?.bloat.functions;

  // Should never happen
  if (currentCrateOrFunction == undefined) {
    throw Error("Neither crates or functions are defined!");
  }

  for (const o of currentCrateOrFunction) {
    currentCratesObj[crateOrFunctionName(o)] = o.size;
  }
  const masterCratesObj: { [key: string]: number } = {};
  for (const o of masterCrateOrFunction || []) {
    masterCratesObj[crateOrFunctionName(o)] = o.size;
  }

  // Ignore unknown crates for now.
  delete currentCratesObj["[Unknown]"];
  delete masterCratesObj["[Unknown]"];

  const crateDifference: CrateDifference[] = [];

  // Crates with new or altered values
  for (const [name, newValue] of Object.entries(currentCratesObj)) {
    let oldValue: number | null = masterCratesObj[name] || null;
    if (oldValue == null) {
      oldValue = null;
    } else {
      delete masterCratesObj[name];
    }
    if (shouldIncludeInDiff(newValue, oldValue)) {
      crateDifference.push({ name, new: newValue, old: oldValue });
    }
  }

  // Crates that have been removed
  for (const [name, oldValue] of Object.entries(masterCratesObj)) {
    crateDifference.push({ name, new: null, old: oldValue });
  }

  const currentSize = current.bloat["file-size"];
  const currentTextSize = current.bloat["text-section-size"];

  const oldSize = masterFileSize;
  const oldTextSize = masterTextSize;

  return {
    packageName,
    sizeDifference,
    textDifference,
    crateDifference,
    currentSize,
    oldSize,
    currentTextSize,
    oldTextSize,
    masterCommit,
    currentCommit: context.sha,
  };
}

export async function getMasterBranchSnapshot(axios: AxiosInstance, repo_name: string, toolchain: string): Promise<Snapshot | null> {
  const key = snapshotKey(repo_name, toolchain) + suffix(true, "ref");
  core.info(`Fetching snapshot with key - ${key}`);
  const res = await axios.get(`/get/${key}`);
  core.info(`Response: ${JSON.stringify(res.data.result, null, 2)}`);
  return (JSON.parse(res?.data?.result) as Snapshot) ?? null;
}

export async function saveSnapshot(axios: AxiosInstance, repo_name: string, snapshot: Snapshot, ref: string, is_default_branch: boolean): Promise<void> {
  const key = snapshotKey(repo_name, snapshot.toolchain) + suffix(is_default_branch, ref);
  core.info(`Saving snapshot with key - ${key}`);
  await axios.post(`/set/${key}`, snapshot);
}

const snapshotKey = (repo_name: string, toolchain: string) => `${repo_name}-${toolchain}`;
const suffix = (is_default_branch: boolean, ref: string) => (is_default_branch ? "-main" : `-${ref}`);
