import axios from "axios";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { compareSnapshots, Snapshot, getMasterBranchSnapshot, saveSnapshot } from "./snapshots";
import { BloatOutput, CargoPackage, getCargoPackages, getToolchainVersions, installCargoDependencies, Package, runCargoBloat, runCargoTree, Versions } from "./bloat";
// import {createOrUpdateComment, createSnapshotComment} from './comments'
import * as io from "@actions/io";
import { createComment, createOrUpdateComment, createSnapshotComment } from "./comments";

const ALLOWED_EVENTS = ["pull_request", "push"];

const KV_URL = "https://known-crane-36141.kv.vercel-storage.com/";

async function run(): Promise<void> {
  if (!ALLOWED_EVENTS.includes(github.context.eventName)) {
    core.setFailed(`This can only be used with the following events: ${ALLOWED_EVENTS.join(", ")}`);
    return;
  }

  const repo_name = github.context.repo.repo;
  const ref = github.context.ref.replace(/\//g, "_");
  const is_default_branch = !ref.includes("pull") && (ref.includes("main") || ref.includes("master"));

  core.info(`GITHUB CONTEXT REF: ${ref} | IS DEFAULT BRANCH: ${is_default_branch}`);

  const cargoPath: string = await io.which("cargo", true);

  await core.group("Installing cargo dependencies", async () => {
    await installCargoDependencies(cargoPath);
  });

  const versions = await core.group("Toolchain info", async (): Promise<Versions> => {
    return getToolchainVersions();
  });

  const packages = await core.group("Inspecting cargo packages", async (): Promise<Array<CargoPackage>> => {
    return await getCargoPackages(cargoPath);
  });

  const packageData: Record<string, Package> = {};

  for (const cargoPackage of packages) {
    const bloatData = await core.group(`Running cargo-bloat on package ${cargoPackage.name}`, async (): Promise<BloatOutput> => {
      return await runCargoBloat(cargoPath, cargoPackage.name);
    });
    const treeData = await core.group(`Running cargo-tree on package ${cargoPackage.name}`, async (): Promise<string> => {
      return await runCargoTree(cargoPath, cargoPackage.name);
    });
    packageData[cargoPackage.name] = { bloat: bloatData, tree: treeData };
  }

  const currentSnapshot: Snapshot = {
    commit: github.context.sha,
    toolchain: versions.toolchain,
    rustc: versions.rustc,
    bloat: versions.bloat,
    packages: packageData,
  };

  const _axios = axios.create({
    baseURL: KV_URL,
    headers: {
      Authorization: `Bearer ${core.getInput("kv_token")}`,
    },
  });

  if (github.context.eventName == "push") {
    return await core.group("Saving Snapshot", async () => {
      return await saveSnapshot(_axios, repo_name, currentSnapshot, ref, is_default_branch);
    });
  }

  // A merge request
  const masterSnapshot = await core.group("Fetching last build", async (): Promise<Snapshot | null> => {
    return await getMasterBranchSnapshot(_axios, repo_name, versions.toolchain);
  });

  await core.group("Posting comment", async (): Promise<void> => {
    const masterCommit = masterSnapshot?.commit || null;
    const snapShotDiffs = Object.entries(currentSnapshot.packages).map((obj) => {
      const [name, currentPackage] = obj;
      return compareSnapshots(name, masterCommit, currentPackage, masterSnapshot?.packages?.[name] || null);
    });
    core.info('..creating comment');
    core.info('SNAPSHOT DIFF LEN: ' + snapShotDiffs.length);
    const comment = createComment(masterCommit, currentSnapshot.commit, versions.toolchain, snapShotDiffs);
    await createOrUpdateComment(versions.toolchain, comment);
  });
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error: any) {
    core.setFailed(error?.message ?? error);
  }
}

main();
