import { set } from "lodash";
import { ExecOptions } from "@actions/exec/lib/interfaces";
import * as exec from "@actions/exec";

export function shouldIncludeInDiff(newValue: number, oldValue: number | null): boolean {
  const changedThreshold = 4000;
  const newThreshold = 512;

  if (oldValue == null) {
    // If we are adding a new crate that adds less than 512 bytes of bloat, ignore it.
    return newValue > newThreshold;
  }
  const numberDiff = newValue - oldValue;

  // If the size difference is between 4kb either way, don't record the difference.
  if (numberDiff > -changedThreshold && numberDiff < changedThreshold) {
    return false;
  }

  return newValue != oldValue;
}

export async function captureOutput(cmd: string, args: Array<string>): Promise<string> {
  let stdout = "";

  const options: ExecOptions = {};
  options.listeners = {
    stdout: (data: Buffer): void => {
      stdout += data.toString();
    },
  };
  await exec.exec(cmd, args, options);
  return stdout;
}
