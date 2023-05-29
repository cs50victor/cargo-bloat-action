import * as github from "@actions/github";
import { context } from "@actions/github";
import * as core from "@actions/core";
import { SnapshotDifference } from "./snapshots";
import { partial } from "filesize";
import table from "text-table";
import { shouldIncludeInDiff } from "./utils";

const binarySize = (size: number) => partial({ standard: "jedec", output: "string" })(size) as string;

export function githubClient() {
  const token = core.getInput("token");
  return github.getOctokit(token);
}

async function postNewComment(message: string, client: ReturnType<typeof githubClient>): Promise<void> {
  await client.rest.issues.createComment({
    body: validateMsg(message),
    issue_number: context.issue.number,
    owner: context.issue.owner,
    repo: context.issue.repo,
  });
}

async function updateComment(message: string, comment_id: number, client: ReturnType<typeof githubClient>): Promise<void> {
  await client.rest.issues.updateComment({
    body: validateMsg(message),
    comment_id,
    owner: context.issue.owner,
    repo: context.issue.repo,
  });
}

export async function createOrUpdateComment(toolchain: string, message: string): Promise<void> {
  core.info(`Find comments for issue: ${github.context.issue.number}`);
  const client = githubClient();

  // client.rest.pulls.
  const comments = await client.rest.issues.listComments({
    owner: context.issue.owner,
    repo: context.issue.repo,
    issue_number: context.issue.number,
    per_page: 100,
  });

  if (comments.status != 200) {
    return core.setFailed(`Error fetching comments for MR ${github.context.issue.number}`);
  }
  core.info(`Found ${comments.data.length} comments. Searching for comments containing ${toolchain}`);

  const ourComments = comments.data.filter((v) => {
    // Is there a better way to do this?
    return v.user?.login == "github-actions[bot]" && v.body?.includes(toolchain);
  });

  if (!ourComments.length) {
    core.info("No existing comment found, creating a new comment");
    await postNewComment(message, client);
  } else {
    // Update the first comment
    const id = ourComments[0].id;
    core.info(`Updating comment with ID ${id}`);
    await updateComment(message, id, client);
  }
}

export function createSnapshotComment(diff: SnapshotDifference): string {
  const crateTableRows: Array<[string, string]> = [];
  diff.crateDifference.forEach((d) => {
    if (d.old === null && d.new === null) {
      return;
    }
    if (d.old === d.new) {
      crateTableRows.push([`${d.name}`, binarySize(d.new as number)]);
    } else {
      if (d.old) {
        crateTableRows.push([`- ${d.name}`, binarySize(d.old)]);
      }
      if (d.new) {
        crateTableRows.push([`+ ${d.name}`, binarySize(d.new)]);
      }
    }
  });

  const sizeTableRows: Array<[string, string, string]> = [];
  if (shouldIncludeInDiff(diff.currentSize, diff.oldSize)) {
    sizeTableRows.push(["- Size", binarySize(diff.oldSize), ""]);
    sizeTableRows.push(["+ Size", `${binarySize(diff.currentSize)}`, `${diff.sizeDifference > 0 ? "+" : ""}${binarySize(diff.sizeDifference)}`]);
  } else {
    sizeTableRows.push(["Size", binarySize(diff.currentTextSize), ""]);
  }

  if (shouldIncludeInDiff(diff.currentTextSize, diff.oldTextSize)) {
    sizeTableRows.push(["- Text Size", binarySize(diff.oldTextSize), ""]);
    sizeTableRows.push(["+ Text Size", `${binarySize(diff.currentTextSize)}`, `${diff.textDifference > 0 ? "+" : ""}${binarySize(diff.textDifference)}`]);
  } else {
    sizeTableRows.push(["Text size", binarySize(diff.currentTextSize), ""]);
  }

  const crateTable = table(crateTableRows);

  const sizeTable = table(sizeTableRows);

  const crateDetailsText = getCrateDetailsText(crateTableRows, crateTable);

  return `
\`\`\`diff
@@ Size breakdown @@

${sizeTable}

\`\`\`

${crateDetailsText}
`;
}

export function createComment(masterCommit: string | null, currentCommit: string, toolchain: string, snapshots: SnapshotDifference[]): string {
  const emojiList = {
    apple: "apple",
    windows: "office",
    arm: "muscle",
    linux: "paperclip",
  };

  let selectedEmoji = "crab";

  for (const [key, emoji] of Object.entries(emojiList)) {
    if (toolchain.includes(key)) {
      selectedEmoji = emoji;
      break;
    }
  }

  const compareCommitText = masterCommit == null ? "" : `([Compare with baseline commit](https://github.com/${context.repo.owner}/${context.repo.repo}/compare/${masterCommit}..${currentCommit}))`;

  let innerComment;

  if (snapshots.length == 1) {
    innerComment = `<summary><strong>${snapshots[0].packageName}</strong><br />${createSnapshotComment(snapshots[0])}`;
  } else {
    innerComment = snapshots
      .map((snapshot) => {
        const comment = createSnapshotComment(snapshot);
        return `<details>
<summary><strong>${snapshot.packageName}</strong>${shouldIncludeInDiff(snapshot.currentSize, snapshot.oldSize) ? " (Changes :warning:)" : ""}</summary>
<br />
${comment}
</details>`;
      })
      .join("\n");
  }

  return `
  :${selectedEmoji}: Cargo bloat for toolchain **${toolchain}**

  ${innerComment}

  Commit: ${currentCommit} ${compareCommitText}
  `;
}

const validateMsg = (msg: string) => {
  // 65536 is the max length of a comment
  if (msg.length > 65536) {
    return msg.slice(0, 65536);
  }
  return msg;
};

const getCrateDetailsText = (crateTableRows: Array<[string, string]>, crateTable: string) => {
  const len = crateTableRows.length;
  if (len == 0) {
    return "No changes to crate sizes";
  }
  return `
<details>
<summary>Size difference per crate</summary>
<br />

**Note:** The numbers below are not 100% accurate, use them as a rough estimate.

\`\`\`diff
@@ Breakdown per crate @@

${crateTable}
\`\`\`

</details>
`;
};
