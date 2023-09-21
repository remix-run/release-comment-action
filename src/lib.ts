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

let DRY_RUN = core.getBooleanInput("DRY_RUN");

function debug(message: string) {
  if (DRY_RUN || core.isDebug()) {
    console.debug(message);
  }
}

function filterBoolean<T>(value: T | null | undefined): value is T {
  return value != undefined;
}

export async function getTags(PACKAGE_NAME: string, INCLUDE_NIGHTLY: boolean) {
  let args = [
    "tag",
    "-l",
    PACKAGE_NAME ? `${PACKAGE_NAME}@*` : null,
    PACKAGE_NAME && INCLUDE_NIGHTLY ? "v0.0.0-nightly-*" : null,
    "--sort",
    "-creatordate",
    "--format",
    "%(refname:strip=2)",
  ].filter(filterBoolean);
  debug(`> git ${args.join(" ")}`);
  let gitTagsResult = await execa("git", args);

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
    if (preRelease && preRelease.join(".") === "pre.0") {
      debug(`first pre-release: ${latest.clean}`);
      let stableTags = getStableTags(gitTags);
      previous = stableTags[0];
    }
  } else if (isStable) {
    debug(`stable: ${latest.clean}`);
    let stableTags = getStableTags(gitTags);
    previous = stableTags[1];
  } else {
    debug(`nightly: ${latest.clean}`);
  }

  return { latest, previous, isPreRelease, isStable, isNightly };
}

export async function getCommits(
  previous: Tag,
  latest: Tag,
  directory?: string,
) {
  let gitCommitArgs = [
    "log",
    "--pretty=format:%H",
    `${previous.raw}...${latest.raw}`,
    directory,
  ].filter(filterBoolean);

  debug(`> git ${gitCommitArgs.join(" ")}`);
  let gitCommitsResult = await execa("git", gitCommitArgs);

  if (gitCommitsResult.stderr) {
    core.error(gitCommitsResult.stderr);
    throw new Error(gitCommitsResult.stderr);
  }

  let gitCommits = gitCommitsResult.stdout.split("\n");

  debug(`> commitCount: ${gitCommits.length}`);

  return gitCommits;
}

export async function main() {
  let PACKAGE_NAME = core.getInput("PACKAGE_NAME");
  let DIRECTORY_TO_CHECK = core.getInput("DIRECTORY_TO_CHECK");
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
  process.env.GH_TOKEN = core.getInput("GH_TOKEN", { required: true });

  if (!PACKAGE_NAME) {
    core.warning("`PACKAGE_NAME` is not set, we'll get all tags");
  }

  let tags = await getTags(PACKAGE_NAME, INCLUDE_NIGHTLY);
  debug(JSON.stringify(tags));

  let commits = await getCommits(
    tags.previous,
    tags.latest,
    DIRECTORY_TO_CHECK,
  );

  let prs = await findMergedPRs(commits);
  let count = prs.length === 1 ? "1 merged PR" : `${prs.length} merged PRs`;
  debug(`> found ${count} that changed ${DIRECTORY_TO_CHECK}`);

  await commentOnIssuesAndPRs(
    tags.latest.clean,
    tags.isStable,
    prs,
    GITHUB_REPOSITORY,
    PR_LABELS_TO_REMOVE,
    ISSUE_LABELS_TO_REMOVE,
  );
}

export async function commentOnIssuesAndPRs(
  latest: string,
  isStable: boolean,
  prs: Array<MergedPR>,
  repo: string,
  prLabelsToRemove: string,
  issueLabelsToRemove: string,
) {
  for (let pr of prs) {
    let prComment = `🤖 Hello there,\n\nWe just published version \`${latest}\` which includes this pull request. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;
    let issueComment = `🤖 Hello there,\n\nWe just published version \`${latest}\` which involves this issue. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;

    let promises = [];

    if (!DRY_RUN) {
      console.log(`https://github.com/${repo}/pull/${pr.number}`);
      let prCommentArgs = [
        "pr",
        "comment",
        String(pr.number),
        "--body",
        prComment,
      ];
      debug(`> gh ${prCommentArgs.join(" ")}`);
      promises.push(execa("gh", prCommentArgs));

      if (prLabelsToRemove && isStable) {
        let args = [
          "pr",
          "edit",
          String(pr.number),
          "--remove-label",
          prLabelsToRemove,
        ];
        debug(`> gh ${args.join(" ")}`);
        promises.push(execa("gh", args));
      }

      for (let issue of pr.issues) {
        console.log(`https://github.com/${repo}/issues/${issue}`);

        let args = ["issue", "comment", String(issue), "--body", issueComment];
        debug(`> gh ${args.join(" ")}`);
        promises.push(execa("gh", args));

        let issueCloseArgs = ["issue", "close", String(issue)];
        debug(`> gh ${issueCloseArgs.join(" ")}`);
        promises.push(execa("gh", issueCloseArgs));

        if (issueLabelsToRemove && isStable) {
          let args = [
            "issue",
            "edit",
            String(issue),
            "--remove-label",
            issueLabelsToRemove,
          ];
          debug(`> gh ${args.join(" ")}`);
          promises.push(execa("gh", args));
        }
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

export type MergedPR = {
  number: number;
  issues: Array<number>;
};

export type Tag = {
  clean: string;
  raw: string;
};

export function getStableTags(tags: Array<Tag>): Array<Tag> {
  return tags.filter((tag) => {
    return semver.prerelease(tag.clean) === null;
  });
}

export async function getIssuesClosedViaBody(
  prBody: string,
): Promise<Array<number>> {
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

export async function findMergedPRs(
  commits: Array<string>,
): Promise<MergedPR[]> {
  let CHANGESET_PR_TITLES = [
    "chore: update version for release",
    "chore: update version for release (pre)",
  ];
  let result = await Promise.all(
    commits.map(async (commit) => {
      let prSearchArgs = [
        "pr",
        "list",
        "--search",
        commit,
        "--state",
        "merged",
        "--json",
        "number,title,url,body",
      ];
      debug(`> gh ${prSearchArgs.join(" ")}`);
      let prResult = await execa("gh", prSearchArgs);

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
    }),
  );

  return result.filter(filterBoolean);
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

export async function getIssuesLinkedToPullRequest(
  prHtmlUrl: string,
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

  let args = [
    "api",
    "graphql",
    "--paginate",
    "--field",
    `prHtmlUrl=${prHtmlUrl}`,
    "--raw-field",
    `query=${trimNewlines(query)}`,
  ];
  debug(`> gh ${args.join(" ")}`);
  let result = await execa("gh", args);

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
    (node) => node.number,
  );
}
