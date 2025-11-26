// 1. get all remix@ and v0.0.0-nightly-* tags sorted by creation date
// 2. get all commits between current and last tag that changed ./packages using `git`
// 3. check if commit is a PR and get the number,title,body using `gh`
// 4. get issues that are linked in the PR using `gh api`
// 5. comment on PRs and issues with the release version using `gh issue comment` and `gh pr comment`
// 6. close issues that are referenced in the PRs using `gh issue close`

import * as core from "@actions/core";
import { execa } from "execa";
import semver from "semver";
import { trimNewlines } from "trim-newlines";
import { z } from "zod";

/*
To run locally, you can provide inputs with `INPUT_` prefixes:

INPUT_DRY_RUN="true" \
INPUT_PACKAGE_NAME="react-router" \
INPUT_DIRECTORY_TO_CHECK="packages/." \
INPUT_INCLUDE_NIGHTLY="false" \
INPUT_GITHUB_REPOSITORY="remix-run/react-router" \
INPUT_ISSUE_LABELS_TO_REMOVE="awaiting-release" \
node ../release-comment-action/src/index.ts
*/

let PACKAGE_NAME = core.getInput("PACKAGE_NAME");
let DIRECTORY_TO_CHECK = core.getInput("DIRECTORY_TO_CHECK");
let DRY_RUN = core.getBooleanInput("DRY_RUN");
let GITHUB_REPOSITORY = core.getInput("GITHUB_REPOSITORY");
let INCLUDE_NIGHTLY = core.getBooleanInput("INCLUDE_NIGHTLY");
let PR_LABELS_TO_REMOVE = core.getInput("PR_LABELS_TO_REMOVE");
let ISSUE_LABELS_TO_REMOVE = core.getInput("ISSUE_LABELS_TO_REMOVE");

// in order to use the `gh` cli that's provided, we need to set the GH_TOKEN
// env variable to the value of the GH_TOKEN input
// not sure if i like it as an input vs having a user have it set in their env
// but at least we can set a default this way...
// doing it the other way would be as follows
/**
  - name: 📝 Comment on issues
    uses: remix-run/release-comment-action
    env:
      GH_TOKEN: ${{ github.token }}
    with:
      PACKAGE_TAGS_TO_FOLLOW: remix
 */
process.env.GH_TOKEN = core.getInput("GH_TOKEN", { required: !DRY_RUN });

if (!PACKAGE_NAME) {
  core.warning("`PACKAGE_NAME` is not set, we'll get all tags");
}

function debug(message: string) {
  console.debug(message);
}

async function main() {
  let gitTagsArgs = [
    "tag",
    "-l",
    PACKAGE_NAME ? `${PACKAGE_NAME}@*` : null,
    PACKAGE_NAME && INCLUDE_NIGHTLY ? "v0.0.0-nightly-*" : null,
    "--sort",
    "-creatordate",
    "--format",
    "%(refname:strip=2)",
  ].filter((arg: any): arg is string => arg !== null);
  let gitTagsResult = await execa("git", gitTagsArgs);

  debug(`> ${gitTagsResult.command}`);

  if (gitTagsResult.stderr) {
    core.error(gitTagsResult.stderr);
    throw new Error(gitTagsResult.stderr);
  }

  let packageRegex = PACKAGE_NAME ? new RegExp(`^${PACKAGE_NAME}@`) : null;
  let gitTags = gitTagsResult.stdout.split("\n").map((tag) => {
    let clean = packageRegex ? tag.replace(packageRegex, "") : tag;
    return { raw: tag, clean };
  });

  let [latest, previous] = gitTags;

  let isStable = semver.prerelease(latest.clean) === null;
  let isNightly = latest.clean.startsWith("v0.0.0-nightly-");
  let isPreRelease = !isStable && !isNightly;

  // if prerelease && pre.0 OR stable, then we need to get the previous stable version
  // if pre.x, then we need to get the previous pre.x version
  if (isPreRelease) {
    debug(`pre-release: ${latest.clean}`);
    let preRelease = semver.prerelease(latest.clean);

    if (!preRelease || typeof preRelease[1] !== "number") {
      core.error("Unable to parse prerelease");
      throw new Error("Unable to parse prerelease");
    }

    if (preRelease.join(".") === "pre.0") {
      // pre.0 - compare against the prior stable release
      previous = findPreviousStableRelease(latest, gitTags);
      debug(`prior stable: ${previous.clean}`);
    } else {
      // >=pre.1 - compare against the prior prerelease
      let priorTag = latest.raw.replace(
        preRelease.join("."),
        [preRelease[0], preRelease[1] - 1].join(".") // pre.N-1`
      );
      let priorPreRelease = gitTags.find((tag) => tag.raw === priorTag);
      if (priorPreRelease) {
        previous = priorPreRelease;
      } else {
        let err = `Unable to find prior prerelease tag ${priorTag}`;
        core.error(err);
        throw new Error(err);
      }
      debug(`prior pre-release: ${previous.clean}`);
    }
  } else if (isStable) {
    debug(`stable: ${latest.clean}`);
    previous = findPreviousStableRelease(latest, gitTags);
    debug(`prior stable: ${previous.clean}`);
  } else {
    debug(`nightly: ${latest.clean}`);
  }

  debug(
    JSON.stringify({ latest, previous, isPreRelease, isStable, isNightly })
  );

  let gitCommitArgs = [
    "log",
    "--pretty=format:%H",
    `${previous.raw}...${latest.raw}`,
    DIRECTORY_TO_CHECK!,
  ];

  debug(`> git ${gitCommitArgs.join(" ")}`);

  let gitCommitsResult = await execa("git", gitCommitArgs);

  if (gitCommitsResult.stderr) {
    core.error(gitCommitsResult.stderr);
    throw new Error(gitCommitsResult.stderr);
  }

  let gitCommits = gitCommitsResult.stdout.split("\n");

  debug(`> commitCount: ${gitCommits.length}`);

  let prs = await findMergedPRs(gitCommits);
  let count = prs.length === 1 ? "1 merged PR" : `${prs.length} merged PRs`;
  debug(`> found ${count} that changed ${DIRECTORY_TO_CHECK}`);

  if (DRY_RUN) {
    debug("");
    debug(
      "Exiting due to DRY_RUN - found the following PRs and linked issues:"
    );
    for (let pr of prs) {
      debug(` - https://github.com/${GITHUB_REPOSITORY}/pull/${pr.number}`);
      for (let issue of pr.issues) {
        debug(`   - https://github.com/${GITHUB_REPOSITORY}/issues/${issue}`);
      }
    }
    process.exit(0);
    return;
  }

  for (let pr of prs) {
    let prComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which includes this pull request. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;
    let issueComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which involves this issue. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;

    let promises = [];

    console.log(`https://github.com/${GITHUB_REPOSITORY}/pull/${pr.number}`);
    // prettier-ignore
    let prCommentArgs = ["pr", "comment", String(pr.number), "--body", prComment];
    promises.push(execa("gh", prCommentArgs));
    debug(`> gh ${prCommentArgs.join(" ")}`);

    if (PR_LABELS_TO_REMOVE && isStable) {
      let prRemoveLabelArgs = [
        "pr",
        "edit",
        String(pr.number),
        "--remove-label",
        PR_LABELS_TO_REMOVE,
      ];
      debug(`> gh ${prRemoveLabelArgs.join(" ")}`);
      promises.push(execa("gh", prRemoveLabelArgs));
    }

    for (let issue of pr.issues) {
      console.log(`https://github.com/${GITHUB_REPOSITORY}/issues/${issue}`);

      // prettier-ignore
      let issueCommentArgs = ["issue", "comment", String(issue), "--body", issueComment];
      debug(`> gh ${issueCommentArgs.join(" ")}`);
      promises.push(execa("gh", issueCommentArgs));

      let issueCloseArgs = ["issue", "close", String(issue)];
      debug(`> gh ${issueCloseArgs.join(" ")}`);
      promises.push(execa("gh", issueCloseArgs));

      if (ISSUE_LABELS_TO_REMOVE && isStable) {
        let issueRemoveLabelArgs = [
          "issue",
          "edit",
          String(issue),
          "--remove-label",
          ISSUE_LABELS_TO_REMOVE,
        ];
        debug(`> gh ${issueRemoveLabelArgs.join(" ")}`);
        promises.push(execa("gh", issueRemoveLabelArgs));
      }
    }

    let results = await Promise.allSettled(promises);
    let failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      core.error(`the following commands failed: ${JSON.stringify(failures)}`);
      throw new Error("failed to comment on PRs and issues");
    }
  }
}

function findPreviousStableRelease(tag: Tag, gitTags: Tag[]): Tag {
  let stableTags = getStableTags(gitTags);
  let expectedMajor = semver.major(tag.clean);
  if (semver.minor(tag.clean) === 0 && semver.patch(tag.clean) === 0) {
    expectedMajor -= 1;
  }
  let previous = stableTags.find(
    (t) => semver.major(t.clean) === expectedMajor
  );
  if (!previous) {
    let err = `No previous stable release found for prior major version ${expectedMajor}`;
    core.error(err);
    throw new Error(err);
  }
  return previous;
}

type MergedPR = {
  number: number;
  issues: Array<number>;
};

type Tag = {
  clean: string;
  raw: string;
};

function getStableTags(tags: Array<Tag>): Array<Tag> {
  return tags.filter((tag) => {
    return semver.prerelease(tag.clean) === null;
  });
}

async function getIssuesClosedViaBody(prBody: string): Promise<Array<number>> {
  if (!prBody) return [];

  /**
   * This regex matches for one of github's issue references for auto linking an issue to a PR
   * as that only happens when the PR is sent to the default branch of the repo
   * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword
   */
  let regex =
    /(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(:)?\s#([0-9]+)/gi;

  let matches = prBody.match(regex);
  if (!matches) return [];

  let issuesMatch = matches.map((match) => {
    let [, issueNumber] = match.split(" #");
    return parseInt(issueNumber, 10);
  });

  return issuesMatch;
}

let pullRequestResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
});

async function findMergedPRs(commits: Array<string>): Promise<MergedPR[]> {
  let CHANGESET_PR_TITLES = [
    "chore: update version for release",
    "chore: update version for release (pre)",
  ];
  let result = await Promise.all(
    commits.map(async (commit) => {
      let prResult = await execa("gh", [
        "pr",
        "list",
        "--search",
        commit,
        "--state",
        "merged",
        "--json",
        "number,title,url,body",
      ]);

      debug(`> ${prResult.command}`);

      if (prResult.stderr) {
        core.error(prResult.stderr);
        throw new Error(prResult.stderr);
      }
      let parsed = JSON.parse(prResult.stdout);

      if (parsed.length === 0) return;

      let pr = parsed[0] ? pullRequestResultSchema.parse(parsed[0]) : null;

      if (!pr) return;

      if (CHANGESET_PR_TITLES.includes(pr.title.toLowerCase())) {
        debug(`skipping changeset PR ${pr.number}`);
        return;
      }

      let linkedIssues = await getIssuesLinkedToPullRequest(pr.url);
      let issuesClosedViaBody = await getIssuesClosedViaBody(pr.body);

      debug(JSON.stringify({ linkedIssues, issuesClosedViaBody }));

      let uniqueIssues = new Set([...linkedIssues, ...issuesClosedViaBody]);

      return {
        number: pr.number,
        issues: [...uniqueIssues],
      };
    })
  );

  return result.filter((pr: any): pr is MergedPR => pr != undefined);
}

let referencedIssueResultSchema = z.object({
  data: z.object({
    resource: z.object({
      closingIssuesReferences: z.object({
        nodes: z.array(z.object({ number: z.number() })),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
    }),
  }),
});

async function getIssuesLinkedToPullRequest(
  prHtmlUrl: string
): Promise<Array<number>> {
  let gql = String.raw;

  let query = gql`
    query ($prHtmlUrl: URI!, $endCursor: String) {
      resource(url: $prHtmlUrl) {
        ... on PullRequest {
          closingIssuesReferences(first: 100, after: $endCursor) {
            nodes {
              number
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  let result = await execa("gh", [
    "api",
    "graphql",
    "--paginate",
    "--field",
    `prHtmlUrl=${prHtmlUrl}`,
    "--raw-field",
    `query=${trimNewlines(query)}`,
  ]);

  debug(`> ${result.command}`);

  if (result.stderr) {
    core.error(result.stderr);
    throw new Error(result.stderr);
  }

  debug(result.stdout);

  let parsed = JSON.parse(result.stdout);

  let valid = referencedIssueResultSchema.safeParse(parsed);

  if (!valid.success) {
    core.error(`Unexpected result from graphql query`);
    core.error(JSON.stringify(valid.error));
    throw new Error(`Unexpected result from graphql query`);
  }

  return valid.data.data.resource.closingIssuesReferences.nodes.map(
    (node) => node.number
  );
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    core.setFailed(`Action failed with error ${error}`);
  }
);
