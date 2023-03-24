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

let PACKAGE_VERSION_TO_FOLLOW = process.env.PACKAGE_VERSION_TO_FOLLOW;
let GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
let DRY_RUN = process.env.DRY_RUN;

if (!PACKAGE_VERSION_TO_FOLLOW) {
  core.error("PACKAGE_VERSION_TO_FOLLOW is required");
  process.exit(1);
}

if (!GITHUB_REPOSITORY) {
  core.error("GITHUB_REPOSITORY is required");
  process.exit(1);
}

async function main() {
  let gitTagsResult = await execa("git", [
    "tag",
    "-l",
    `${PACKAGE_VERSION_TO_FOLLOW}@*`,
    "v0.0.0-nightly-*",
    "--sort",
    "-creatordate",
    "--format",
    "%(refname:strip=2)",
  ]);

  core.debug(`> ${gitTagsResult.command}`);

  if (gitTagsResult.stderr) {
    core.error(gitTagsResult.stderr);
    process.exit(gitTagsResult.exitCode);
  }

  let packageRegex = new RegExp(`^${PACKAGE_VERSION_TO_FOLLOW}@`);
  let gitTags = gitTagsResult.stdout.split("\n").map((tag) => {
    let clean = tag.replace(packageRegex, "");
    return { raw: tag, clean };
  });

  let [latest, previous] = gitTags;

  let isStable = semver.prerelease(latest.clean) === null;
  let isNightly = latest.clean.startsWith("v0.0.0-nightly-");
  let isPreRelease = !isStable && !isNightly;

  // if prerelease && pre.0 OR stable, then we need to get the previous stable version
  // if pre.x, then we need to get the previous pre.x version
  if (isPreRelease) {
    core.debug(`pre-release: ${latest.clean}`);
    let preRelease = semver.prerelease(latest.clean);
    if (preRelease && preRelease.join(".") === "pre.0") {
      core.debug(`first pre-release: ${latest.clean}`);
      let stableTags = getStableTags(gitTags);
      previous = stableTags[0];
    }
  } else if (isStable) {
    core.debug(`stable: ${latest.clean}`);
    let stableTags = getStableTags(gitTags);
    previous = stableTags[1];
  } else {
    core.debug(`nightly: ${latest.clean}`);
  }

  core.debug(
    JSON.stringify({ latest, previous, isPreRelease, isStable, isNightly })
  );

  let gitCommitsResult = await execa("git", [
    "log",
    "--pretty=format:%H",
    `${previous.raw}...${latest.raw}`,
    "./packages",
  ]);

  core.debug(gitCommitsResult.command);

  if (gitCommitsResult.stderr) {
    core.error(gitCommitsResult.stderr);
    process.exit(gitCommitsResult.exitCode);
  }

  let gitCommits = gitCommitsResult.stdout.split("\n");

  core.debug(JSON.stringify({ gitCommits, commitCount: gitCommits.length }));

  let prs = await findMergedPRs(gitCommits);
  core.debug(`found ${prs.length} merged PRs that changed ./packages/*`);

  for (let pr of prs) {
    let prComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which includes this pull request. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;
    let issueComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which involves this issue. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;

    let promises = [];

    if (!DRY_RUN) {
      console.log(`https://github.com/${GITHUB_REPOSITORY}/pull/${pr.number}`);
      // prettier-ignore
      let prCommentArgs = ["pr", "comment", String(pr.number), "--body", prComment];
      promises.push(execa("gh", prCommentArgs));
      core.debug(`> gh ${prCommentArgs.join(" ")}`);

      for (let issue of pr.issues) {
        console.log(`https://github.com/${GITHUB_REPOSITORY}/issues/${issue}`);

        // prettier-ignore
        let issueCommentArgs = ["issue", "comment", String(issue), "--body", issueComment];
        promises.push(execa("gh", issueCommentArgs));
        core.debug(`> gh ${issueCommentArgs.join(" ")}`);

        let issueCloseArgs = ["issue", "close", String(issue)];
        core.debug(`> gh ${issueCloseArgs.join(" ")}`);
        promises.push(execa("gh", issueCloseArgs));
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

type PrSearchResult = {
  number: number;
  title: string;
  url: string;
  body: string;
};

function isPullRequestResult(pr: any): pr is PrSearchResult {
  return (
    typeof pr === "object" &&
    typeof pr.number === "number" &&
    typeof pr.title === "string" &&
    typeof pr.url === "string" &&
    typeof pr.body === "string"
  );
}

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

      core.debug(`> ${prResult.command}`);

      if (prResult.stderr) {
        core.error(prResult.stderr);
        throw new Error(prResult.stderr);
      }
      let parsed = JSON.parse(prResult.stdout);

      if (parsed.length === 0) {
        core.debug(`no PR found for commit ${commit}`);
        return;
      }

      let pr = isPullRequestResult(parsed[0]) ? parsed[0] : null;

      if (!pr) {
        core.debug(`no PR found for commit ${commit}`);
        return;
      }

      if (CHANGESET_PR_TITLES.includes(pr.title.toLowerCase())) {
        core.debug(`skipping changeset PR ${pr.number}`);
        return;
      }

      let linkedIssues = await getIssuesLinkedToPullRequest(pr.url);
      let issuesClosedViaBody = await getIssuesClosedViaBody(pr.body);

      core.debug(JSON.stringify({ linkedIssues, issuesClosedViaBody }));

      let uniqueIssues = new Set([...linkedIssues, ...issuesClosedViaBody]);

      return {
        number: pr.number,
        issues: [...uniqueIssues],
      };
    })
  );

  return result.filter((pr: any): pr is MergedPR => pr != undefined);
}

type ReferencedIssueResult = {
  data: {
    resource: {
      closingIssuesReferences: {
        nodes: Array<{ number: number }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string;
        };
      };
    };
  };
};

function isReferencedResult(result: any): result is ReferencedIssueResult {
  let isNode = (node: any): node is { number: number } => {
    return typeof node === "object" && typeof node.number === "number";
  };

  let isPageInfo = (
    pageInfo: any
  ): pageInfo is { hasNextPage: boolean; endCursor: string } => {
    return (
      typeof pageInfo === "object" &&
      typeof pageInfo.hasNextPage === "boolean" &&
      typeof pageInfo.endCursor === "string"
    );
  };

  let isClosingIssuesReferences = (
    closingIssuesReferences: any
  ): closingIssuesReferences is {
    nodes: Array<{ number: number }>;
    pageInfo: { hasNextPage: boolean; endCursor: string };
  } => {
    return (
      typeof closingIssuesReferences === "object" &&
      typeof closingIssuesReferences.nodes === "object" &&
      closingIssuesReferences.nodes.every(isNode) &&
      typeof closingIssuesReferences.pageInfo === "object" &&
      isPageInfo(closingIssuesReferences.pageInfo)
    );
  };

  return (
    typeof result === "object" &&
    typeof result.data === "object" &&
    typeof result.data.resource === "object" &&
    typeof result.data.resource.closingIssuesReferences === "object" &&
    isClosingIssuesReferences(result.data.resource.closingIssuesReferences)
  );
}

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

  core.debug(`> ${result.command}`);

  if (result.stderr) {
    core.error(result.stderr);
  }

  console.log(result.stdout);

  let parsed = JSON.parse(result.stdout);

  if (!isReferencedResult(parsed)) {
    core.error(`Unexpected result from graphql query`);
    return [];
  }

  return parsed.data.resource.closingIssuesReferences.nodes.map(
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
